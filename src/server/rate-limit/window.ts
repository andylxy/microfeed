import type {RateLimitKind, WindowRule} from "./kinds";
import {maybePruneExpired} from "./prune";

/**
 * 固定窗口计数器（`ext_rate_limit` 的 `count` 语义）。
 *
 * 三个调用方共用这套算术，差别只在**什么时候调**：
 * - `AUTH_THROTTLE`：请求先计数再判定（登录端点）；
 * - `APP_QUOTA`：鉴权与版本门都通过后才计数（App 内容端点）；
 * - `LOGIN_FAILURE`：只在失败时记一次，成功时清空（凭证登录）。
 *
 * 拒绝路径不写库：达上限的判定只读行，这是 App 配额「被拒流量 D1 代价为零」
 * 那条约束的实现点。并发把计数顶过上限的那一次请求允许通过（边界请求）。
 */

/** `ext_rate_limit` 里一行计数器。 */
export interface WindowRow {
  count: number;
  expires_at_ms: number;
}

export interface WindowDecision {
  allowed: boolean;
  /** 仅在被拒时有意义：距窗口终点的秒数，用于 `Retry-After`。 */
  retryAfterSeconds: number;
}

/** 批次读取用的 SELECT：与设备吊销、凭证校验等其他语句同批执行。 */
export function readWindowStatement(
  db: D1Database,
  kind: RateLimitKind,
  key: string,
): D1PreparedStatement {
  return db.prepare(
    "SELECT count, expires_at_ms FROM ext_rate_limit " +
      "WHERE kind = ? AND key = ? LIMIT 1",
  ).bind(kind, key);
}

/** 行判定：没有行、窗口已过期、或次数未满都允许。只读，不写库。 */
export function windowAllows(
  row: WindowRow | null | undefined,
  max: number,
  now = Date.now(),
): boolean {
  if (!row || Number(row.expires_at_ms) <= now) return true;
  return Number(row.count) < max;
}

/** 计数语句：窗口翻转时原地重置，否则原子递增。 */
function windowUpsertStatement(
  db: D1Database,
  rule: WindowRule,
  key: string,
  now: number,
): D1PreparedStatement {
  const nextExpiry = now + rule.windowMs;
  return db.prepare(
    "INSERT INTO ext_rate_limit (kind, key, count, expires_at_ms) " +
      "VALUES (?, ?, 1, ?) ON CONFLICT(kind, key) DO UPDATE SET " +
      "count = CASE WHEN ext_rate_limit.expires_at_ms <= ? " +
      "THEN 1 ELSE ext_rate_limit.count + 1 END, " +
      "expires_at_ms = CASE WHEN ext_rate_limit.expires_at_ms <= ? " +
      "THEN ? ELSE ext_rate_limit.expires_at_ms END " +
      "RETURNING count, expires_at_ms",
  ).bind(rule.kind, key, nextExpiry, now, now, nextExpiry);
}

/**
 * 用批次已经取回的行做判定与计数。达上限直接拒绝、不执行 UPSERT；
 * 否则单条 UPSERT 原子递增。
 */
export async function consumeWindowFromRow(
  db: D1Database,
  rule: WindowRule,
  key: string,
  row: WindowRow | null | undefined,
  options: {now?: number} = {},
): Promise<WindowDecision> {
  const now = options.now ?? Date.now();
  if (!windowAllows(row, rule.max, now)) {
    const expiresAtMs = Number(row?.expires_at_ms ?? now);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((expiresAtMs - now) / 1000)),
    };
  }
  const counted = await windowUpsertStatement(db, rule, key, now)
    .first<WindowRow>();
  await maybePruneExpired(db, now);
  const count = Number(counted?.count ?? 1);
  const expiresAtMs = Number(counted?.expires_at_ms ?? now + rule.windowMs);
  if (count > rule.max) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((expiresAtMs - now) / 1000)),
    };
  }
  return {allowed: true, retryAfterSeconds: 0};
}

/** 单条调用入口：先取行，再判定与计数。 */
export async function consumeWindow(
  db: D1Database,
  rule: WindowRule,
  key: string,
  options: {now?: number} = {},
): Promise<WindowDecision> {
  const now = options.now ?? Date.now();
  const row = await readWindowStatement(db, rule.kind, key).first<WindowRow>();
  return consumeWindowFromRow(db, rule, key, row, {now});
}

/**
 * 只记一次，不做上限判定。给「上限已经在批次一读过」的失败计数用：
 * 调用方已经拒绝过的请求不该再读一次行。
 */
export async function recordWindowHit(
  db: D1Database,
  rule: WindowRule,
  key: string,
  options: {now?: number} = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  await windowUpsertStatement(db, rule, key, now).first<WindowRow>();
  await maybePruneExpired(db, now);
}

/** 清空一个键的计数（登录成功后调用）。 */
export async function clearWindow(
  db: D1Database,
  kind: RateLimitKind,
  key: string,
): Promise<void> {
  await db.prepare(
    "DELETE FROM ext_rate_limit WHERE kind = ? AND key = ?",
  ).bind(kind, key).run();
}

/** 一次查询取一批键的计数行（后台面板显示用量用）。 */
export async function readWindows(
  db: D1Database,
  kind: RateLimitKind,
  keys: string[],
): Promise<Map<string, WindowRow>> {
  const found = new Map<string, WindowRow>();
  if (keys.length === 0) return found;
  const placeholders = keys.map(() => "?").join(", ");
  const result = await db.prepare(
    "SELECT key, count, expires_at_ms FROM ext_rate_limit " +
      `WHERE kind = ? AND key IN (${placeholders})`,
  ).bind(kind, ...keys).all<{key: string; count: number; expires_at_ms: number}>();
  for (const row of result.results ?? []) {
    found.set(row.key, {count: row.count, expires_at_ms: row.expires_at_ms});
  }
  return found;
}
