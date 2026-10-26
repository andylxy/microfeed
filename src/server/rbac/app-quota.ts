import {sha256Hex} from "@/shared/crypto";
import type {AppRequestQuotaUsage} from "@/shared/LoginCredential";
import {workerCacheKey, workerCacheOrNull} from "@/server/cache/worker-cache";

/**
 * App 内容端点按凭证限流（ADR-0048 / F3）。
 *
 * 参数（唯一定义处）：
 * - 窗口 24h、每凭证上限 10,000 次——合法重度读者翻页远低于 2,000 次/日；
 * - 计数范围 = `/api/AppBookRequest/` 内容路由（middleware 的 isIntegrationApiPath
 *   门内），匿名端点与 `/api/v1` 不计数；
 * - 被拒请求不计数、不写库：若逐条记录被拒事件，攻击者被拒 1 次即消耗 1 行写
 *   额度，100 请求/秒持续一天即烧光 100,000 日写额度——拒绝路径的 D1 代价必须
 *   为零，这是本模块所有设计分支的第一约束。
 *
 * 判定链（每请求）：
 * 1. Cache API 标记 `quota-exhausted/<tokenHash>` 命中 → 直接 429，零 D1。标记
 *    在首次达上限时写入、TTL 到 reset 时刻；`caches.default` 不跨数据中心复制，
 *    每个 POP 首次触达各花 1 行读后自持，攻击读代价 ≤ 2 × POP 数 / 凭证 / 日。
 * 2. SELECT 当前计数：已达上限 → 写标记 + 429（此路径只读不写，被拒请求的常态
 *    是第 1 步，这里是跨 POP 首次或缓存失效时的过渡）。
 * 3. 未达上限 → 单条 UPSERT ... RETURNING 原子递增（1 读 + 1 写）。并发把计数
 *   顶过上限的那一次请求允许通过（边界请求），之后的请求全部走第 1/2 步。
 *
 * 表结构见迁移 0147：行数 = 活跃凭证数，窗口翻转原地重置。计数形态沿用
 * `src/server/auth/login-throttle.ts` 的固定窗口先例。
 */
export const APP_REQUEST_QUOTA_MAX = 10_000;
export const APP_REQUEST_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 标记键的内部 origin：与 app-cache 的内部 origin 同形、互不重叠。 */
const QUOTA_MARKER_ORIGIN = "https://app-quota.microfeed.internal";
/** Cache API 写入的最小 TTL（秒）：更短的标记没有意义，跳过写入。 */
const MARKER_MIN_TTL_SECONDS = 2;

export interface AppRequestQuotaDecision {
  allowed: boolean;
  /** 仅在被拒时有意义：距窗口重置的秒数，用于 `Retry-After`。 */
  retryAfterSeconds: number;
}

async function markerKey(token: string): Promise<URL> {
  const tokenHash = await sha256Hex(token);
  return workerCacheKey(QUOTA_MARKER_ORIGIN, `/quota/${tokenHash}`);
}

/**
 * 鉴权前的廉价检查（middleware 在防重放之前调用）：只用调用方手里的原始
 * token 计算哈希，不查库。标记里存了 reset 时刻，命中即可给出 Retry-After。
 */
export async function appQuotaExhaustedMarker(
  token: string,
  now = Date.now(),
): Promise<number | null> {
  const cache = workerCacheOrNull();
  if (!cache) return null;
  try {
    const hit = await cache.match(await markerKey(token));
    if (!hit) return null;
    const resetAtMs = Number(hit.headers.get("x-quota-reset-at-ms") ?? 0);
    if (!Number.isFinite(resetAtMs) || resetAtMs <= now) return null;
    return Math.ceil((resetAtMs - now) / 1000);
  } catch {
    return null;
  }
}

/** 首次达上限时写标记；写失败只影响该 POP 的后续请求多花一次 SELECT，不影响正确性。 */
export async function markQuotaExhausted(
  token: string,
  resetAtMs: number,
  now = Date.now(),
): Promise<void> {
  const cache = workerCacheOrNull();
  if (!cache) return;
  const ttl = Math.ceil((resetAtMs - now) / 1000);
  if (ttl < MARKER_MIN_TTL_SECONDS) return;
  try {
    await cache.put(await markerKey(token), new Response("quota exhausted", {
      headers: {
        "cache-control": `public, max-age=${ttl}`,
        "x-quota-reset-at-ms": String(resetAtMs),
      },
    }));
  } catch {
    // 写不进（本地 dev / 权限受限）：退化为每次被拒多 1 行 SELECT。
  }
}

export interface AppRequestQuotaRow {
  count: number;
  reset_at_ms: number;
}

/** 批次二用的 SELECT：middleware 把它与设备吊销同批执行（方案 6）。 */
export function quotaSelectStatement(
  db: D1Database,
  credentialId: string,
): D1PreparedStatement {
  return db.prepare(
    "SELECT count, reset_at_ms FROM ext_app_request_quota " +
      "WHERE credential_id = ? LIMIT 1",
  ).bind(credentialId);
}

/** 计数语句：窗口翻转时原地重置，否则原子递增。 */
export function quotaUpsertStatement(
  db: D1Database,
  credentialId: string,
  now = Date.now(),
): D1PreparedStatement {
  const nextReset = now + APP_REQUEST_QUOTA_WINDOW_MS;
  return db.prepare(
    "INSERT INTO ext_app_request_quota (credential_id, count, reset_at_ms) " +
      "VALUES (?, 1, ?) ON CONFLICT(credential_id) DO UPDATE SET " +
      "count = CASE WHEN ext_app_request_quota.reset_at_ms <= ? " +
      "THEN 1 ELSE ext_app_request_quota.count + 1 END, " +
      "reset_at_ms = CASE WHEN ext_app_request_quota.reset_at_ms <= ? " +
      "THEN ? ELSE ext_app_request_quota.reset_at_ms END " +
      "RETURNING count, reset_at_ms",
  ).bind(credentialId, nextReset, now, now, nextReset);
}

/**
 * 由已取回的计数行给出决定；`null` 表示未达上限、需要执行 UPSERT。
 * 达上限时**不写库**——拒绝路径的 D1 写代价必须为零。
 */
function exhaustedFromRow(
  row: AppRequestQuotaRow | null | undefined,
  now: number,
): AppRequestQuotaDecision | null {
  if (row && Number(row.reset_at_ms) > now &&
      Number(row.count) >= APP_REQUEST_QUOTA_MAX) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((Number(row.reset_at_ms) - now) / 1000),
    };
  }
  return null;
}

/**
 * 用批次二已经取回的计数行做判定与计数（middleware 在版本门之后调用）。
 * 达上限直接拒绝、不执行 UPSERT；否则单条 UPSERT 原子递增。
 */
export async function consumeAppRequestQuotaFromRow(
  db: D1Database,
  credentialId: string,
  row: AppRequestQuotaRow | null | undefined,
  options: {now?: number} = {},
): Promise<AppRequestQuotaDecision> {
  const now = options.now ?? Date.now();
  const exhausted = exhaustedFromRow(row, now);
  if (exhausted) return exhausted;
  const counted = await quotaUpsertStatement(db, credentialId, now)
    .first<AppRequestQuotaRow>();
  const count = Number(counted?.count ?? 1);
  const resetAtMs = Number(counted?.reset_at_ms ?? now + APP_REQUEST_QUOTA_WINDOW_MS);
  if (count > APP_REQUEST_QUOTA_MAX) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - now) / 1000)),
    };
  }
  return {allowed: true, retryAfterSeconds: 0};
}

/**
 * 鉴权成功后的计数消费（单条调用入口）。credentialId 来自鉴权结果——无效
 * token 到不了这里，表不会被随机 token 灌垃圾行。
 */
export async function consumeAppRequestQuota(
  db: D1Database,
  credentialId: string,
  options: {now?: number} = {},
): Promise<AppRequestQuotaDecision> {
  const now = options.now ?? Date.now();
  const row = await quotaSelectStatement(db, credentialId)
    .first<AppRequestQuotaRow>();
  return consumeAppRequestQuotaFromRow(db, credentialId, row, {now});
}

/**
 * 429 响应：旧后端信封形状（`{code, data, msg}`，App 的 RequestHandler 按
 * code 判定成功失败），中文文案与 envelope.ts 的「请求成功」同一口径。
 */
export function appRequestQuotaResponse(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({
      code: 429,
      data: null,
      msg: "请求过于频繁，请稍后再试",
    }),
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
        "retry-after": String(Math.max(1, retryAfterSeconds)),
      },
      status: 429,
    },
  );
}

/**
 * 面板读取（后台「凭证管理」显示今日用量）：一次查询取一批凭证的计数行。
 * 行不存在 = 该凭证当日还没有 App 调用，面板显示为空。
 */
export async function readAppRequestQuotaRows(
  db: D1Database,
  credentialIds: string[],
): Promise<Map<string, AppRequestQuotaUsage>> {
  const found = new Map<string, AppRequestQuotaUsage>();
  if (credentialIds.length === 0) return found;
  const placeholders = credentialIds.map(() => "?").join(", ");
  const result = await db.prepare(
    "SELECT credential_id, count, reset_at_ms FROM ext_app_request_quota " +
      `WHERE credential_id IN (${placeholders})`,
  ).bind(...credentialIds).all<{
    credential_id: string;
    count: number;
    reset_at_ms: number;
  }>();
  for (const row of result.results ?? []) {
    found.set(row.credential_id, {
      count: Number(row.count),
      resetAtMs: Number(row.reset_at_ms),
    });
  }
  return found;
}
