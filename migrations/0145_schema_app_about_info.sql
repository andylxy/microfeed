-- 0145_ext_app_about_info.sql
--
-- App 关于页内容（AboutInfo，对应旧后端 getAboutInfo / DevConfig APP_ABOUT）。
-- 后台「关于页内容」管理页（/admin/app-about/）按 name 槽位维护 text，
-- 公开端点 `GET /api/AppBookRequest/getAboutInfo` 全表读出拼成 [{name, text}]
-- （App 端 AboutActivity 按 name 固定分发 4 个槽位，未知 name 丢弃）。
--
-- ## name 槽位（App 契约，AndroidProject-old AboutActivity.ABOUT_*）
--
--   about_thks      致谢        → tvThks
--   about_manual    使用手册    → tvDeveloper
--   about_bookname  书名作者    → tvAuthorBook
--   app_updata_log  更新日志    → tvUpdataLog
--
-- name 是主键也是 App 的分发枚举；将来 App 新增槽位时加行即可，无需改表。
-- text 为逐字字符串（App 自有 `$x{...}` 标记 + `|` 分行，非 Markdown），
-- 后台编辑器只作输入面板，内容原样存取（ADR-0029 存取约定）。
--
-- ## 一次性数据迁移
--
-- 旧存储是 settings 表 webGlobalSettings 行 JSON 的可选 `aboutInfo` 数组
-- （[{text, name}]）。用 `json_each` 拆行搬入；旧字段从此不再被读取，
-- 保留原样不清理（与「已应用迁移一字不动」同理，历史数据不做破坏性变更）。
-- `INSERT OR IGNORE` 保证 D1 重放时幂等（name 主键去重）。
--
-- 幂等：CREATE TABLE IF NOT EXISTS / INSERT OR IGNORE。

CREATE TABLE IF NOT EXISTS ext_app_about_info (
  name       VARCHAR(80) PRIMARY KEY,
  text       TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO ext_app_about_info (name, text)
SELECT
  json_extract(je.value, '$.name'),
  COALESCE(json_extract(je.value, '$.text'), '')
FROM settings, json_each(settings.data, '$.aboutInfo') je
WHERE settings.category = 'webGlobalSettings'
  AND json_type(je.value) = 'object'
  AND json_extract(je.value, '$.name') IS NOT NULL;

-- ------------------------------------------------------------------
-- 权限码 + 后台菜单 + 权限树节点（0087/0127 模式；治理类挂 group_operations）
--
-- ⚠️ id 必须与 `permissionId()`（src/server/rbac/seed.ts）逐字节一致：
--    公式 `p_<code 中 ':' → '_'>`，其余字符原样保留：
--        system:app-about:read   → p_system_app-about_read
--        system:app-about:manage → p_system_app-about_manage
--
-- 三镜像：本文件 ≡ `PERMISSION_CODES`（src/shared/Constants.ts）
--        ≡ `RBAC_PERMISSIONS`（src/server/rbac/seed.ts），由
-- `tests/unit/admin-endpoint-guards.test.ts` 与 `tests/worker/rbac.test.ts` 守住。
--
-- 角色授权：本文件**不写** `ext_role_permissions`。super_admin 靠 `*` 通配
-- 天然拥有，editor / readonly 不授予（治理类口径，与公告一致）。
--
-- 幂等：INSERT OR IGNORE。type = seed，回滚块照写（豁免 MIG-004）：
-- rollback:
--   DELETE FROM ext_permission_nodes WHERE code IN ('system:app-about:read', 'system:app-about:manage', 'page_app_about');
--   DELETE FROM ext_menu WHERE code = 'app_about';
--   DELETE FROM ext_permissions WHERE code IN ('system:app-about:read', 'system:app-about:manage');

-- 1. 权限码
INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_system_app-about_read',   'system:app-about:read',   '关于页查看'),
  ('p_system_app-about_manage', 'system:app-about:manage', '关于页管理');

-- 2. 后台菜单行：挂「运营管理」组（devices 601 / app_versions 602 / login_logs 603 /
--    announcements 604 / cloud_usage 605 之后），sort 606。菜单可见性只认
--    `ext_menu.permission_code` 直列（ADR-0038，ext_menu_permissions 零读零写不碰）。
--    图标 `file-text` 已登记在 AdminMenuItemLink 的 MENU_ICONS。
--    name_zh / name_en（0125 列）必须与 i18n `menu.item.appAbout` 逐字一致
--    （admin-menu.test 的 display-names 断言守住）。
INSERT OR IGNORE INTO ext_menu
  (id, code, parent_code, path, i18n_key, icon, permission_code, sort, is_visible, name_zh, name_en, created_at_ms)
VALUES
  ('m_app_about', 'app_about', 'group_operations', 'app-about', 'menu.item.appAbout', 'file-text', 'system:app-about:read', 606, 1, '关于页内容', 'About page content', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- 3. 权限树节点：页面节点 + 两个码叶子（0133 起页面节点要带 path / entry_code，
--    合并后的侧栏从节点读取，缺了这两列菜单会少一行——admin-menu.test 守住）。
INSERT OR IGNORE INTO ext_permission_nodes
  (id, code, kind, parent_code, sort, audience, path, entry_code, permission_code, name_zh, name_en, icon, i18n_key, is_visible, source, created_at_ms) VALUES
  ('pn_page_app_about', 'page_app_about', 'page', 'group_operations', 608, 'desktop', 'app-about', 'system:app-about:read', NULL, '关于页内容', 'About page content', 'file-text', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_system_app-about_read', 'system:app-about:read', 'code', 'page_app_about', 0, 'desktop', NULL, NULL, 'system:app-about:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_system_app-about_manage', 'system:app-about:manage', 'code', 'page_app_about', 1, 'desktop', NULL, NULL, 'system:app-about:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
