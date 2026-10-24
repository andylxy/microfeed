-- 0149_index_webhook_endpoints_deleted_at.sql
--
-- webhook 端点清理路径走索引（ADR-0048 D3 / F8）：`pruneWebhookHistory` 里
-- 「删除已过保留期的软删端点」外层按 `deleted_at < ?` 范围删，此前用不上
-- webhook_endpoints_status (status, deleted_at, updated_at)（status 无等值
-- 条件）而整表 SCAN。本索引取代 ADR-0043 D8 的「行数 >200 再建」触发条件：
-- 表当前 0 行（.scratch/sec-hardening/probe-rowcounts-2026-10-24.stdout.txt），
-- 空表建索引写额度消耗 0 行；内层 NOT EXISTS 仍按
-- webhook_deliveries_endpoint (endpoint_id, created_at) 点查，不随本索引变化。

CREATE INDEX IF NOT EXISTS ix_webhook_endpoints_deleted_at
  ON webhook_endpoints (deleted_at);
