-- 0140_index_webhook_deliveries_event.sql
--
-- 0140: webhook_deliveries 增加 event_id 索引
--
-- pruneWebhookHistory 的事件删除改为 NOT EXISTS 后按 event_id 反查投递：
--   DELETE FROM webhook_events
--   WHERE created_at < ... AND NOT EXISTS (
--     SELECT 1 FROM webhook_deliveries d WHERE d.event_id = webhook_events.id
--   )
-- 现有索引 webhook_deliveries_created / _endpoint / _reconcile 都不含 event_id。
-- 改写前的 `NOT IN (SELECT event_id FROM webhook_deliveries)` 把子查询的 event_id
-- 整列物化一次，一次读取 30 天保留期内留存的全部投递行：默认日上限 1,000 行时
-- 30,000 行，日上限配置到 1,000,000 时 30,000,000 行（两个数字都是「日上限 ×
-- 保留天数」的推得值）。本索引让改写后的
-- 每条候选事件按 event_id 走
-- `SEARCH ... USING COVERING INDEX ix_webhook_deliveries_event (event_id=?)`（在副本上
-- 创建本索引后取该计划，`probe-round5.mjs`），
-- 每条候选读取 1 条索引项；留存投递多于本次候选事件时，索引形态读取的行数少于
-- 整列物化。事件一侧继续走现有 webhook_events_created (created_at
-- DESC, id DESC)。本地投递 0 行、表 4,096 字节（1 页），两种形态本地都读取
-- 0 行 0 字节；本索引在副本上实测 4,096 字节 / 1 页（`probe-indexes2.mjs`）。
-- 创建索引写入 0 行，占每日 100,000 行
-- 写入额度的 0%。
-- 回滚：DROP INDEX IF EXISTS ix_webhook_deliveries_event;

CREATE INDEX IF NOT EXISTS ix_webhook_deliveries_event
  ON webhook_deliveries(event_id);
