-- 0152_seed_app_cache_control.sql
--
-- App 缓存控制面后台页（/admin/cache/）的权限码 + 菜单行 + 权限树节点。
-- 页面读写控制项本体（`settings` category='app_cache_control'，由代码读写，
-- 本迁移不碰），并触发 `cache.purge({tags})` 清空条目。方案见
-- `.scratch/app-cache-analysis/plan.md` 第 5 节。
--
-- ## 权限码（治理类，挂 group_operations）
--
--   system:cache:manage  打开页面、读控制项、保存、清空
--
-- 只设一个码：清空会带来约 22,013 行回源读，能打开这一页的人就是能付这笔
-- 代价的人；单独设只读码只会让页面多一个永远禁用的「清空」按钮。
--
-- ⚠️ id 必须与 `permissionId()`（src/server/rbac/seed.ts）逐字节一致：
--    公式 `p_<code 中 ':' → '_'>`，其余字符原样保留：
--        system:cache:manage → p_system_cache_manage
--
-- 三镜像：本文件 ≡ `PERMISSION_CODES`（src/shared/Constants.ts）
--        ≡ `RBAC_PERMISSIONS`（src/server/rbac/seed.ts），由
-- `tests/unit/admin-endpoint-guards.test.ts` 与 `tests/worker/rbac.test.ts` 守住。
--
-- 角色授权：本文件**不写** `ext_role_permissions`。super_admin 靠 `*` 通配
-- 天然拥有，editor / readonly 不授予（治理类口径，与 0145 / 0150 一致）。
--
-- 幂等：INSERT OR IGNORE。type = seed，回滚块照写（豁免 MIG-004）：
-- rollback:
--   DELETE FROM ext_permission_nodes WHERE code IN ('system:cache:manage', 'page_app_cache');
--   DELETE FROM ext_menu WHERE code = 'app_cache';
--   DELETE FROM ext_permissions WHERE code = 'system:cache:manage';

-- 1. 权限码
INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_system_cache_manage', 'system:cache:manage', '缓存管理');

-- 2. 后台菜单行：挂「运营管理」组（devices 601 / app_versions 602 / login_logs 603 /
--    announcements 604 / cloud_usage 605 / app_about 606 / login_methods 607 之后），
--    sort 608。菜单可见性只认 `ext_menu.permission_code` 直列（ADR-0038）。
--    图标 `storage` 已登记在 AdminMenuItemLink 的 MENU_ICONS 与 MenuIconNames。
--    name_zh / name_en（0125 列）必须与 i18n `menu.item.app_cache` 逐字一致
--    （admin-menu.test 的 display-names 断言守住）。
INSERT OR IGNORE INTO ext_menu
  (id, code, parent_code, path, i18n_key, icon, permission_code, sort, is_visible, name_zh, name_en, created_at_ms)
VALUES
  ('m_app_cache', 'app_cache', 'group_operations', 'cache', 'menu.item.app_cache', 'storage', 'system:cache:manage', 608, 1, '缓存管理', 'Cache control', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- 3. 权限树节点：页面节点 + 一个码叶子（0133 起页面节点要带 path / entry_code，
--    合并后的侧栏从节点读取，缺了这两列菜单会少一行——admin-menu.test 守住）。
--    节点侧 sort 610：组内实测最大 609（0150 的 page_login_methods），取 +1。
INSERT OR IGNORE INTO ext_permission_nodes
  (id, code, kind, parent_code, sort, audience, path, entry_code, permission_code, name_zh, name_en, icon, i18n_key, is_visible, source, created_at_ms) VALUES
  ('pn_page_app_cache', 'page_app_cache', 'page', 'group_operations', 610, 'desktop', 'cache', 'system:cache:manage', NULL, '缓存管理', 'Cache control', 'storage', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_system_cache_manage', 'system:cache:manage', 'code', 'page_app_cache', 0, 'desktop', NULL, NULL, 'system:cache:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
