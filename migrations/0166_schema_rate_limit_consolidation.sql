-- 0166_schema_rate_limit_consolidation.sql
--
-- 限流与一次性台账合并为一张 ext_rate_limit（ADR-0056）。
--
-- 改造前五张表各自表达「一段时间内的请求记账」，窗口、时间单位与清理方式
-- 各不相同：
--   ext_auth_throttle             登录端点按 IP + 路径计数，秒，无清理
--   ext_app_request_quota         App 内容端点按凭证计数，毫秒，无清理
--   ext_login_credential_attempts 凭证登录失败计数，毫秒，登录成功即删行
--   ext_replay_nonces             防重放 nonce 去重，ISO 字符串，1% 采样清理
--   ext_captcha_nonce             图形验证码一次性记账，毫秒，写入路径清理
--
-- 合并的依据只有一条不变量：一行在 expires_at_ms 之后无意义。
--   - 窗口计数器：expires_at_ms 是窗口终点，窗口翻转时原地重置 count；
--   - 一次性台账：count 恒为 1，expires_at_ms 是保留终点。
-- 于是清理只剩一条 DELETE ... WHERE expires_at_ms < ?，三种清理策略收敛成一种。
--
-- kind 进主键：分类隔离由 schema 保证，不再依赖 key 字符串前缀约定。前缀写错
-- 不会报错，只会静默多出一行，让那个分类的计数被绕过。
--
-- 行都是运行态，不做回填：旧表直接删除，新表从空开始。切换后第一个窗口内计数
-- 从 0 起算，nonce 台账从空起算——两者都是短周期语义，不需要迁移历史行。
--
-- 部署注意：本迁移不可回滚。应用后回滚旧版 Worker 代码会查询已删除的表，登录、
-- App 内容端点与防重放全部 500；迁移先于 deploy 执行（deploySupport 既有约定）。
--
-- type = schema。
-- rollback:
--   不可回滚：五张旧表已 DROP。需要恢复时按 0030 / 0037 / 0059 / 0147 / 0156
--   重建表结构，再从 ext_rate_limit 按 kind 分派回灌未过期行。

CREATE TABLE IF NOT EXISTS "ext_rate_limit" (
  "kind"          TEXT    NOT NULL,
  "key"           TEXT    NOT NULL,
  "count"         INTEGER NOT NULL DEFAULT 1,
  "expires_at_ms" INTEGER NOT NULL,
  PRIMARY KEY ("kind", "key")
);

-- 清理与「取最早过期行」共用这一条索引：全表只有一种过期语义。
CREATE INDEX IF NOT EXISTS "ext_rate_limit_expires_idx"
  ON "ext_rate_limit" ("expires_at_ms");

-- 一次 DROP 一张表：迁移扫描器只认每条 DROP 后的第一个表名。
DROP TABLE IF EXISTS "ext_auth_throttle";
DROP TABLE IF EXISTS "ext_app_request_quota";
DROP TABLE IF EXISTS "ext_login_credential_attempts";
DROP TABLE IF EXISTS "ext_replay_nonces";
DROP TABLE IF EXISTS "ext_captcha_nonce";
