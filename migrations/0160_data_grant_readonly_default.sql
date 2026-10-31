-- 0160_data_grant_readonly_default.sql
--
-- 默认角色回填（Rbac.ts DEFAULT_USER_ROLE = "readonly"）：建号逻辑已给新账号默认授
-- r_readonly（rbac-handlers.ts），但存量账号里有若干是在该逻辑落地前注册的，
-- ext_user_roles 里没有任何角色授权 → 按「无授权即无任何权限」处理会连只读都用不了。
-- 本迁移给这批账号补上 r_readonly（只读角色，实测 23 权限）。
--
-- 用「无授权则全补」这一通用策略：每个账号至少 readonly；显式列 id 会把
-- dev/test 库的 user_id 硬编码进迁移，跑测试库时 applyD1Migrations 触发
-- FOREIGN KEY 违例（那些 id 在测试库不存在）；本迁移在任何环境都幂等
-- （已有授权的不受影响）。
-- 实测（dev/test 库 2026-10-30）受惠账号为：
--   probe-bind2 / probe-app / e2e.reg.20261029 / QQ 空壳(5ebee6d2) / xiaoyang_02。
--
-- 只补 ext_user_roles，不动 auth_user.role（那是 better-auth 遗留列，与 RBAC 授权
-- 本就不同步，见现有 r_editor 账号 auth_user.role 仍为 'user'）。
--
-- type = data。
-- rollback:
--   -- 撤销「原本无任何角色授权」的账号被补上的 r_readonly：删除「唯一授权是
--   -- r_readonly」的账号的该授权（这批正是本迁移插入的；原本已有其它角色的
--   -- 账号 NOT EXISTS 为假，本迁移不插入，故不受影响）。
--   DELETE FROM "ext_user_roles"
--    WHERE "role_id" = 'r_readonly'
--      AND "user_id" IN (
--        SELECT a."id" FROM "auth_user" a
--         WHERE NOT EXISTS (
--           SELECT 1 FROM "ext_user_roles" ur
--            WHERE ur."user_id" = a."id" AND ur."role_id" <> 'r_readonly'
--         )
--      );

INSERT OR IGNORE INTO "ext_user_roles" ("user_id", "role_id")
SELECT a."id", 'r_readonly'
  FROM "auth_user" a
 WHERE NOT EXISTS (
   SELECT 1 FROM "ext_user_roles" ur WHERE ur."user_id" = a."id"
 );
