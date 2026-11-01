-- 0163_data_clear_auth_user_role.sql
--
-- 一、清空 auth_user.role。它曾是 ext_user_roles 的派生镜像，只服务 better-auth
--     admin 插件自己的端点（封禁、删除用户等）。插件已移除（ADR-0054），本列
--     从此无写者、无读者，留值只会让后来人以为它还在参与判定。
--
--     列本身保留：删列要重建 auth_user，而它被 18 张表按 userId 引用。
--
--     0161 的漂移订正在此之后成为历史动作：那一版让镜像与真源取同一值，这一版
--     把镜像整体清空，两者不冲突，顺序是「先取值、再废止」。
--
-- 二、订正 signup_source 的越界值。该列是 TEXT NOT NULL DEFAULT 'email'，
--     不会出现 NULL；能出问题的只有「超出三值之外」的行（历史手工 SQL、或将来
--     某条绕过 toSignupSource 的写路径）。这条把越界值收敛回 'email'，与读取层
--     toSignupSource 的兜底同一口径。
--
--     不写 IS NULL：0157 定义的是 NOT NULL，NULL 在存储层写不进去，那条语句永远
--     命中 0 行，还会给人「这里曾经修过 NULL」的错误印象。
--
-- 读量：两条都是 UPDATE ... WHERE 全表条件，SCAN auth_user 一次一条。auth_user
-- 表规模随账号数线性增长，不随内容量增长；本机 9 行。
--
-- type = data。
-- rollback:
--   role 仅对账号仍在的行有意义——从 ext_user_roles 反推（持 super_admin 记
--   'admin'，持其他角色记 'user'）：
--     UPDATE "auth_user"
--        SET "role" = CASE WHEN EXISTS (
--              SELECT 1 FROM "ext_user_roles" ur
--                JOIN "ext_roles" r ON r."id" = ur."role_id"
--               WHERE ur."user_id" = "auth_user"."id" AND r."code" = 'super_admin'
--            ) THEN 'admin' ELSE 'user' END;
--   已被删除的账号无从反推，回滚不会复活。
--   signup_source 的订正不可逆：原值已不满足三值约束，没有保留价值。

UPDATE "auth_user" SET "role" = NULL WHERE "role" IS NOT NULL;

UPDATE "auth_user" SET "signup_source" = 'email'
WHERE "signup_source" NOT IN ('email', 'qq', 'admin');
