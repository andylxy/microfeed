-- 0132_schema_role_admin_login.sql
--
-- 角色加「允许登录后台」开关（`ext_roles.allow_admin_login`）。
--
-- 这一列是角色挂上的否决位，不是一份准入名单：账号所持角色里只要有一个允许，
-- 就能进后台（与权限的并集口径一致）；一个角色都没有的账号不设限——它的用途
-- 是挡住「只给 App 用」的账号，不是重新发明一套白名单。
--
-- 默认 1（允许）：既有库里的角色全部保持原状，升级不改现有行为。
-- `super_admin` 由服务端固定为允许（`setRbacRoleAdminLogin`），否则一次误操作
-- 就能把整个后台锁在门外，而且没有第二个入口改回来。
--
-- 关闭后只影响后台入口：App 内容接口按登录凭证鉴权，不读这一列。
--
-- type = schema。列级 DDL 由 `d1_migrations` 的文件名记账，不可重放。
-- rollback:
--   ALTER TABLE ext_roles DROP COLUMN allow_admin_login;

ALTER TABLE ext_roles ADD COLUMN allow_admin_login INTEGER NOT NULL DEFAULT 1;
