-- 0135_cleanup_retire_menu_management.sql
--
-- 票 04（ADR-0041 D5 / ADR-0042 D6）：菜单管理页整页下线，管辖它的节点与码一并退役。
-- 删除顺序按依赖：角色授权 → 节点 → 权限码 → 菜单映射 → 菜单行。
--
-- 该码自 0126 起只授 super_admin（走 '*' 通配），本地零角色持有；这里仍先清授权，
-- 远程实例若有人手工授过也不会留下悬空外键。
--
-- type = cleanup。rollback 见文件末尾（注释块，执行器不会跑）。
-- rollback:
--   INSERT OR IGNORE INTO ext_permissions (id, code, name)
--     VALUES ('p_system_menu_manage', 'system:menu:manage', '菜单管理');
--   INSERT OR IGNORE INTO ext_menu
--     (id, code, parent_code, path, i18n_key, icon, permission_code, sort, is_visible, created_at_ms)
--     VALUES ('m_menu_management', 'menu_management', 'group_account', 'menu',
--             'menu.item.menu_management', 'list', 'system:menu:manage', 503, 1,
--             CAST(strftime('%s', 'now') AS INTEGER) * 1000);
--   INSERT OR IGNORE INTO ext_menu_permissions (menu_code, permission_code)
--     VALUES ('menu_management', 'system:menu:manage');
--   INSERT OR IGNORE INTO ext_permission_nodes
--     (id, code, kind, parent_code, sort, audience, permission_code, name_zh, name_en,
--      icon, i18n_key, is_visible, source, created_at_ms, path, entry_code)
--     VALUES
--       ('pn_page_menu_management', 'page_menu_management', 'page', 'group_account', 503,
--        'desktop', NULL, '菜单管理', 'Menu management', 'list', NULL, 1, 'seed',
--        CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'menu', 'system:menu:manage'),
--       ('pn_system_menu_manage', 'system:menu:manage', 'code', 'page_menu_management', 0,
--        'desktop', 'system:menu:manage', NULL, NULL, NULL, NULL, 1, 'seed',
--        CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL, NULL);

DELETE FROM ext_role_permissions WHERE permission_id = 'p_system_menu_manage';

DELETE FROM ext_permission_nodes
WHERE code IN ('page_menu_management', 'system:menu:manage');

DELETE FROM ext_permissions WHERE code = 'system:menu:manage';

DELETE FROM ext_menu_permissions WHERE menu_code = 'menu_management';

-- 解析器（tests/unit/admin-page-guards.test.ts）只认这一种形态，不要加别的条件。
DELETE FROM ext_menu WHERE code = 'menu_management';
