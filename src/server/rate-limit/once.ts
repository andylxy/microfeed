import type {RateLimitKind} from "./kinds";
import {maybePruneExpired} from "./prune";

/**
 * 一次性台账（`ext_rate_limit` 的 `count = 1` 语义）：插入即消费。
 *
 * `true` = 首次使用（调用方可以继续）；`false` = 已被用过（必须拒绝）。
 * 用 `INSERT OR IGNORE` 的 `changes` 判定，同一个键并发提交两次只有一次拿到 1。
 *
 * 过期行的存在不影响判定：`INSERT OR IGNORE` 只比对 (kind, key)，与过期时刻无关。
 * 保留期到了由清理删行；删之前同一个键会被判成「已用」——对防重放 nonce 与
 * 图形验证码都是安全侧（多拒一次），不会放过重放。
 */

/**
 * 抢占一个一次性键。
 *
 * `expiresAtMs` 由调用方给：防重放按请求自带的 `X-Timestamp` 加窗口算，
 * 图形验证码按当前时刻加保留期算。
 */
export async function insertOnce(
  db: D1Database,
  kind: RateLimitKind,
  key: string,
  expiresAtMs: number,
  options: {now?: number} = {},
): Promise<boolean> {
  const result = await db.prepare(
    "INSERT OR IGNORE INTO ext_rate_limit (kind, key, count, expires_at_ms) " +
      "VALUES (?, ?, 1, ?)",
  ).bind(kind, key, expiresAtMs).run();
  await maybePruneExpired(db, options.now ?? Date.now());
  return (result.meta?.changes ?? 0) > 0;
}
