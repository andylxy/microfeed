-- 0165_schema_unify_third_party_identity.sql
--
-- 第三方身份绑定统一入 auth_account（ADR-0055）。
--
-- 改造前 QQ 绑定存自建的 ext_user_oauth（主键 (provider, openid)），与 better-auth
-- 的 auth_account（账号 × 提供方多行模型）两套表表达同一件事，绑定查询、改绑、
-- 解绑各写一套 SQL，删号清理与快照登记也要各留一位。
--
-- 合并后 QQ 绑定由 auth_account 的 providerId = 'qq' 行承载：
--   - accountId 列放 openid（该列语义即「提供方侧账户标识」）；
--   - userId 列挂账号（FK CASCADE，删号级联行为与原 ext_user_oauth 一致）；
--   - password 与全部 token 列留 NULL（没有跨登录期消费 token 的调用方）；
--   - 行 id 用确定性值 'acc_qq_' || openid，回填幂等、可重跑。
--
-- 幂等闸门换底座：auth_account 原本没有 (providerId, accountId) 唯一约束，
-- 本迁移补上唯一索引。索引先建（对存量 credential 行 fail-fast 验重），再回填，
-- 最后删表；回填语句 INSERT OR IGNORE，旧快照恢复时重放本迁移即可完成回填与删表。
--
-- 部署注意：本迁移不可回滚。应用后回滚旧版 Worker 代码会查询已删除的表，
-- QQ 登录 / 绑定端点全部 500；迁移先于 deploy 执行（deploySupport 既有约定）。
--
-- type = schema。
-- rollback:
--   不可回滚：ext_user_oauth 已 DROP。需要恢复时须按 0155 重建表结构，
--   再从 auth_account（providerId = 'qq'）回灌 (openid, userId)。

-- 1. 幂等闸门的唯一索引。存量 credential 行一人一行，建索引即隐式验重，
--    任何重复都会让迁移 fail-fast（D1 逐文件事务回滚）。
CREATE UNIQUE INDEX IF NOT EXISTS "auth_account_provider_account"
  ON "auth_account" ("providerId", "accountId");

-- 2. 回填存量 QQ 绑定。id 确定性生成，重放时 INSERT OR IGNORE 全部跳过。
--    createdAt / updatedAt 用 CURRENT_TIMESTAMP（UTC）；响应侧 BoundAtMs
--    由该列换算，应用写入的 ISO 格式行不受影响（解析兼容两种格式）。
INSERT OR IGNORE INTO "auth_account"
  ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt")
SELECT 'acc_qq_' || openid, openid, 'qq', user_id, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "ext_user_oauth";

-- 3. 旧表退役。索引 ext_user_oauth_user_id 随表一起消失。
DROP TABLE IF EXISTS "ext_user_oauth";
