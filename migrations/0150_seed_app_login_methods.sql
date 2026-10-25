-- 0150_seed_app_login_methods.sql
--
-- App 登录管理页（/admin/login-methods/）的权限码 + 后台菜单行（ADR-0050 D6）。
-- 运营在一个页面开关 App 登录页的登录方式显隐与图形验证码强制，配置本体存
-- `settings` 表 category='app_login_methods'（由代码读写，本迁移不碰）。
--
-- ## 权限码（治理类，挂 group_operations）
--
--   system:app-login-methods:read    打开管理页、读配置
--   system:app-login-methods:manage  保存开关
--
-- ⚠️ id 必须与 `permissionId()`（src/server/rbac/seed.ts）逐字节一致：
--    公式 `p_<code 中 ':' → '_'>`，其余字符原样保留——**连字符不转换**：
--        system:app-login-methods:read   → p_system_app-login-methods_read
--        system:app-login-methods:manage → p_system_app-login-methods_manage
--    先例见 0145：system:app-about:read → p_system_app-about_read。
--
-- 三镜像：本文件 ≡ `PERMISSION_CODES`（src/shared/Constants.ts）
--        ≡ `RBAC_PERMISSIONS`（src/server/rbac/seed.ts），由
-- `tests/unit/admin-endpoint-guards.test.ts` 与 `tests/worker/rbac.test.ts` 守住。
--
-- 角色授权：本文件**不写** `ext_role_permissions`。super_admin 靠 `*` 通配
-- 天然拥有，editor / readonly 不授予（治理类口径，与 0145 关于页一致）。
--
-- 幂等：INSERT OR IGNORE。type = seed，回滚块照写（豁免 MIG-004）：
-- rollback:
--   DELETE FROM ext_permission_nodes WHERE code IN ('system:app-login-methods:read', 'system:app-login-methods:manage', 'page_login_methods');
--   DELETE FROM ext_menu WHERE code = 'login_methods';
--   DELETE FROM ext_permissions WHERE code IN ('system:app-login-methods:read', 'system:app-login-methods:manage');

-- 1. 权限码
INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_system_app-login-methods_read',   'system:app-login-methods:read',   '登录方式查看'),
  ('p_system_app-login-methods_manage', 'system:app-login-methods:manage', '登录方式管理');

-- 2. 后台菜单行：挂「运营管理」组（devices 601 / app_versions 602 / login_logs 603 /
--    announcements 604 / cloud_usage 605 / app_about 606 之后），sort 607
--    （2026-10-25 本地库实测组内最大 606，探针 stdout：.scratch/login-management/
--    probe-menu-operations.stdout.txt）。菜单可见性只认 `ext_menu.permission_code`
--    直列（ADR-0038，ext_menu_permissions 零读零写不碰）。图标 `shield-check`
--    已登记在 AdminMenuItemLink 的 MENU_ICONS。
--    name_zh / name_en（0125 列）必须与 i18n `menu.item.appLoginMethods` 逐字一致
--    （admin-menu.test 的 display-names 断言守住）。
INSERT OR IGNORE INTO ext_menu
  (id, code, parent_code, path, i18n_key, icon, permission_code, sort, is_visible, name_zh, name_en, created_at_ms)
VALUES
  ('m_login_methods', 'login_methods', 'group_operations', 'login-methods', 'menu.item.appLoginMethods', 'shield-check', 'system:app-login-methods:read', 607, 1, '登录管理', 'Login methods', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- 3. 权限树节点：页面节点 + 两个码叶子（0133 起页面节点要带 path / entry_code，
--    合并后的侧栏从节点读取，缺了这两列菜单会少一行——admin-menu.test 守住）。
--    节点侧 sort 609：组内实测最大 608（0145 的 page_app_about；606/607 是
--    0129 重组腾出的空位），取最大值 +1 = 609。
INSERT OR IGNORE INTO ext_permission_nodes
  (id, code, kind, parent_code, sort, audience, path, entry_code, permission_code, name_zh, name_en, icon, i18n_key, is_visible, source, created_at_ms) VALUES
  ('pn_page_login_methods', 'page_login_methods', 'page', 'group_operations', 609, 'desktop', 'login-methods', 'system:app-login-methods:read', NULL, '登录管理', 'Login methods', 'shield-check', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_system_app-login-methods_read', 'system:app-login-methods:read', 'code', 'page_login_methods', 0, 'desktop', NULL, NULL, 'system:app-login-methods:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_system_app-login-methods_manage', 'system:app-login-methods:manage', 'code', 'page_login_methods', 1, 'desktop', NULL, NULL, 'system:app-login-methods:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
