-- 0161_data_sync_auth_user_role.sql
--
-- 订正 auth_user.role 与 ext_user_roles 之间的漂移。
--
-- auth_user.role 是「是否持 super_admin」的有损派生镜像（BETTER_AUTH_ADMIN_ROLE /
-- BETTER_AUTH_USER_ROLE，见 src/shared/Rbac.ts），只服务 better-auth admin 插件
-- 自己的端点（封禁、删除用户等），不参与项目授权。两侧不同步有两个方向：
--
--   A 超管被降权：ext_user_roles 有 super_admin，auth_user.role ≠ 'admin'（含 NULL）
--     → 项目守卫放行，但调 better-auth 的封禁/删除端点回 403。
--   B 越权：auth_user.role = 'admin'，ext_user_roles 无 super_admin
--     → 能调 better-auth 端点，却没有任何对应的角色授权。
--
-- 实测（本机实例副本 2026-11-01）：A 方向 1 个账号（6022f637…，role = NULL），
-- B 方向 0 个，role = 'user' 却持 editor 的 2 个属有损镜像的正常取值，不在订正面内。
--
-- 判据用 ext_roles.code 而非 ext_roles.id：id 形如 r_super_admin，各环境未必一致。
-- 三个 WHERE 分支对应上面的两类错向加 NULL 归一，已经正确的行不进 SET。
--
-- 读量（2026-11-01，本机实例副本 9 个账号，EXPLAIN QUERY PLAN 实测）：
--   SCAN auth_user                                   —— 9 行
--   CORRELATED SCALAR SUBQUERY ×3
--     SEARCH r  USING INDEX ext_roles(code)          —— 每次 ≤ 1 行
--     SEARCH ur USING COVERING INDEX ext_user_roles(user_id, role_id)
--                                                    —— 每次该账号的角色数，本机 ≤ 2
-- 三条相关子查询按需短路，上限 9 × 3 × (1 + 2) = 81 次索引项读取；auth_user 9 行
-- 约 2 KB，加上索引读取合计约 10 KB 量级。SCAN auth_user 是 data 迁移的固有形状，
-- 表规模随账号数线性增长，不随内容量增长。
--
-- type = data。
-- rollback:
--   迁移后的取值已满足不变量（role = 'admin' ⟺ 持 super_admin），无法从结果反推
--   哪些行由本迁移改过，所以没有无条件逆语句。回退前先导出原值留档：
--     SELECT "id", "role" FROM "auth_user";
--   回退时按该清单逐行还原：
--     UPDATE "auth_user" SET "role" = ? WHERE "id" = ?;
--   不用改动 d1_migrations 记账行来代替回退：该表以文件名作键，删文件只会让已应用
--   记录无法识别，数据本身不会回滚。

UPDATE "auth_user"
   SET "role" = CASE
     WHEN EXISTS (
       SELECT 1
         FROM "ext_user_roles" ur
         JOIN "ext_roles" r ON r."id" = ur."role_id"
        WHERE ur."user_id" = "auth_user"."id" AND r."code" = 'super_admin'
     ) THEN 'admin'
     ELSE 'user'
   END
 WHERE "role" IS NULL
    OR ("role" = 'admin' AND NOT EXISTS (
         SELECT 1
           FROM "ext_user_roles" ur
           JOIN "ext_roles" r ON r."id" = ur."role_id"
          WHERE ur."user_id" = "auth_user"."id" AND r."code" = 'super_admin'))
    OR ("role" = 'user' AND EXISTS (
         SELECT 1
           FROM "ext_user_roles" ur
           JOIN "ext_roles" r ON r."id" = ur."role_id"
          WHERE ur."user_id" = "auth_user"."id" AND r."code" = 'super_admin'));
