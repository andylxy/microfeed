-- 0139_index_webhook_budget_created.sql
--
-- 0139: webhook_budget_reservations 增加创建时间索引
--
-- pruneWebhookHistory 每天删除 35 天前的预算预留：
--   DELETE FROM webhook_budget_reservations WHERE created_at < datetime(...)
-- 该表只有 id 主键的自动索引，没有以 created_at 为列的索引，删除条件只能
-- 全表扫描；查询计划从 `SCAN webhook_budget_reservations` 变为
-- `SEARCH ... USING INDEX ix_webhook_budget_created (created_at<?)`。
-- 唯一写入点是 redeliverWebhookDelivery：每次手动重投写入一行预留，受触发器与
-- 每日投递预算约束。默认日上限 1,000 行、35 天保留期最多 35,000 行；日上限
-- 配置到 1,000,000 时最多 35,000,000 行，扫描整张表每天都要读取这些行。
-- 本地 0 行、表 4,096 字节（1 页）：两种计划本地都读取 0 行；本索引在 `VACUUM INTO`
-- 副本上实测 4,096 字节（`probe-facts8b.mjs`）。
-- 创建索引写入 0 行，占每日 100,000 行写入额度的 0%。
-- 回滚：DROP INDEX IF EXISTS ix_webhook_budget_created;

CREATE INDEX IF NOT EXISTS ix_webhook_budget_created
  ON webhook_budget_reservations(created_at);
