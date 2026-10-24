-- 0147_schema_app_request_quota.sql
--
-- App 内容端点按凭证限流（ADR-0048 / F3）：每把 mflc_ 凭证一个固定窗口计数器
-- （10,000 次 / 24h，参数唯一定义处在 src/server/rbac/app-quota.ts）。
-- 行数 = 活跃凭证数（凭证数上界 = 用户数 × 5），窗口翻转原地重置，无需清理任务。

CREATE TABLE IF NOT EXISTS ext_app_request_quota (
  credential_id TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at_ms INTEGER NOT NULL
);
