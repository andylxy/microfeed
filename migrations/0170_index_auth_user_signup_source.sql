-- 0170_index_auth_user_signup_source.sql
--
-- `auth_user.signup_source` 的索引。
--
-- 起因：`getSignupSources`（src/server/auth/signup-source.ts）在每次用户页 SSR
-- 上跑 `SELECT DISTINCT signup_source FROM "auth_user"`，把「库里出现过、配置
-- 里没有」的来源补成临时分组，保证手工写入的来源不会让账号从左栏消失。
--
-- 0157 加这一列时没建索引，本地实测计划是：
--   SCAN auth_user                ← D1 扫描门禁 001
--   USE TEMP B-TREE FOR DISTINCT  ← 规则 002
-- 行读随账号总数线性增长，且每次页面加载都付一遍。
--
-- 建索引后 DISTINCT 变成覆盖索引扫描（索引本身有序，不再需要临时 B-tree）。
-- 代价是 `auth_user` 的写入多维护一条索引；该表的写只发生在建号与资料编辑，
-- 频次远低于用户页读取，净收益为正。
--
-- 低基数列（实际取值 3–5 个）不适合做等值查询索引，本条只为 DISTINCT / GROUP BY
-- 的覆盖扫描服务；不要据此再给 `banned` 之类布尔列加同类索引。
--
-- type = index。
-- rollback:
--   DROP INDEX IF EXISTS "ix_auth_user_signup_source";

CREATE INDEX IF NOT EXISTS "ix_auth_user_signup_source"
  ON "auth_user" ("signup_source");
