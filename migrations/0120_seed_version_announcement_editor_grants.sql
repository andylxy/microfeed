-- 0120_seed_version_announcement_editor_grants.sql
--
-- 将 0119 注入的两个 App 能力权限码默认授予 `editor` 角色。
--
-- `/api/app/version` 与 `/api/app/announcements` 改为「登录凭证 + 权限码」之后，必须让
-- editor（App 内置凭证 `mflc_…` 解析到的角色）默认拥有该权限，否则 App 启动拉取升级
-- 描述符 / 停服公告会收到 403 insufficient_scope。
--
-- `seedRbac`（src/server/rbac/seed.ts）只在「首次 admin-bootstrap」时执行，既有的
-- 实例（本地 dev、远端生产）不会重新跑，因此用迁移补一道，保证 editor 在新旧实例上都
-- 拿到授权。这与 0088（搜索）、0096（名词解释）的「运营手工挂角色」不同：这两个端点要
-- 求默认授予，所以写进迁移而非等运营手动勾选。
--
-- 迁移依赖 0119 已写入 ext_permissions 的两条码；editor 角色由首次 seedRbac 落库，
-- 既有实例必然存在。两行用 INSERT OR IGNORE，重复执行幂等。
--
-- 回滚：
--   DELETE FROM ext_role_permissions
--   WHERE role_id = (SELECT id FROM ext_roles WHERE code = 'editor')
--     AND permission_id IN (
--       SELECT id FROM ext_permissions
--       WHERE code IN ('app:version:read', 'app:announcement:read')
--     );

INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM ext_roles r
CROSS JOIN ext_permissions p
WHERE r.code = 'editor'
  AND p.code IN ('app:version:read', 'app:announcement:read');
