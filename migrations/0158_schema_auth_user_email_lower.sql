-- 0158_schema_auth_user_email_lower.sql
--
-- `auth_user.email` 的唯一索引（`sqlite_autoindex_auth_user_2`）是**大小写敏感**的。
-- 实测：`email = 'qq_3974…b9d@oauth.local'`（全小写）命中 0 行，而
-- `lower(email) = 'qq_3974…b9d@oauth.local'` 命中 1 行 —— 因为 QQ 建号的占位邮箱
-- 保留 openid 的**原始大小写**（`createQqUser` 写 `qq_<openid>@oauth.local`，
-- 真实 openid 是大写十六进制，如 `39746869556B3DEAF1163DDCD5A12B9D`）。
--
-- 因此按邮箱查账号必须有 `lower(email) = ?` 这条兜底路径，而它是表达式条件，
-- 没有索引就会退化成全表扫描。本迁移给它建表达式索引，让兜底同样走索引。
--
-- 影响面：账号绑定按 email 定位目标账号（ADR-0014 §4.1 第 3 步）。
--
-- type = schema。
-- rollback:
--   DROP INDEX ix_auth_user_email_lower;

CREATE INDEX IF NOT EXISTS ix_auth_user_email_lower
  ON "auth_user" (lower("email"));
