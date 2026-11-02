/**
 * 过期行清理。
 *
 * 全表只有一种过期语义（`expires_at_ms` 之后无意义），所以清理是一条 DELETE。
 * D1 没有 TTL，也没有定时任务，清理只能搭在写入路径上：按 1% 概率采样。理由是
 * App 通道满额即 1 万次/日/凭证，逐次清理等于把写次数翻倍。
 *
 * 残留的过期行不影响正确性：
 * - 计数器：UPSERT 里有 `expires_at_ms <= now` 就重置 count 的分支；
 * - 台账：`INSERT OR IGNORE` 只比对 (kind, key)，过期行只会让重复键更早被拒，
 *   这是安全侧（多拒一次），不会放过重放。
 *
 * 采样意味着「表的上界」而不是「行数恒为零」：计数器按不同 key 数增长，台账按
 * 保留期内的请求量增长。两条都是流量函数，不是时间函数。
 */

const PRUNE_SAMPLE_RATE = 0.01;

/** 删掉全部过期行。测试与显式维护用；请求路径用 `maybePruneExpired`。 */
export async function pruneExpired(
  db: D1Database,
  now = Date.now(),
): Promise<void> {
  await db.prepare(
    "DELETE FROM ext_rate_limit WHERE expires_at_ms < ?",
  ).bind(now).run();
}

/** 写入路径上的概率清理：1% 采样，其余 99% 直接返回。 */
export async function maybePruneExpired(
  db: D1Database,
  now = Date.now(),
): Promise<void> {
  if (Math.random() >= PRUNE_SAMPLE_RATE) return;
  await pruneExpired(db, now);
}
