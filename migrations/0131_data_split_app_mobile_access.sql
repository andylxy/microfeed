-- 0131_data_split_app_mobile_access.sql
--
-- App 内容端点门码细分（原 `app:mobile:access` 一门管 8 条内容端点，粒度过粗：
-- 只想发某一块的数据做不到），并把 App 端页签结构收拢成单页口径。
--
-- 新码六个（一个码对应一个用途，分发见 `src/server/api/api-permissions.ts`）：
--   app:nav:read       GetNav
--   app:style:read     GetTipsStyleConfig
--   app:chapter:read   GetBookChapter
--   app:content:read   GetChapterContent
--   app:fang:read      GetBookIdFang
--   app:zhongyao:read  GetAllZhongYao / GetAliaZhongYao
-- GetAllMingCi 归入既有 app:mingci:view（名词数据与它的查看权同权）。
--
-- 树形收拢为单页口径（与已确认的原形一致）：
--   group_app（App 端管理）
--     page_app_access   app访问  <- 六个新码叶子 + app:version:read（并入）
--     page_app_search   app搜索  <- app:search:book / global + app:mingci:view（并入）
--     page_app_announcement_read  app公告 <- app:announcement:read
-- page_app_version_read / page_mingci 两个页行随叶子并走后删除。
--
-- 授权等价映射：持有 p_app_mobile_access 的角色获得上述七个新码（六个新码 +
-- app:mingci_view），随后移除 p_app_mobile_access 的授权行。映射是有意放宽的
-- 一处：GetAllMingCi 原先在旧门下，归入 app:mingci:view 后连带开放
-- mingci-permission 端点——端点回答的就是这一个码的持有情况，语义一致。
--
-- ⚠️ id 必须与 `permissionId()`（src/server/rbac/seed.ts）逐字节一致：
--    公式 `p_<code 中 ':' → '_'>`。
--
-- 三镜像：本文件 ≡ `PERMISSION_CODES`（src/shared/Constants.ts）
--        ≡ `RBAC_PERMISSIONS`（src/server/rbac/seed.ts）。
--
-- 幂等：INSERT OR IGNORE + 按 code 的 UPDATE / DELETE，重复执行安全。
--
-- rollback:（授权映射不可逐行反推：区分不了迁移产生的授权与手工授权，只能整体
-- 回退七个码的授权行；若回退前有人手工授过新码，会一并被移除）
--   两个被并走的页（page_app_version_read / page_mingci）要先建回来，再改
--   指向它们的子行，否则回滚后 app:version:read、app:mingci:view 挂着不存在的父级。
--   INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
--     ('p_app_mobile_access', 'app:mobile:access', '移动端权限');
--   INSERT OR IGNORE INTO ext_permission_nodes
--     (id, code, kind, parent_code, sort, audience, permission_code, name_zh, name_en, icon, i18n_key, is_visible, source, created_at_ms) VALUES
--     ('pn_app_mobile_access', 'app:mobile:access', 'code', 'page_api', 0, 'desktop', 'app:mobile:access', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
--   INSERT OR IGNORE INTO ext_permission_nodes
--     (id, code, kind, parent_code, sort, audience, permission_code, name_zh, name_en, icon, i18n_key, is_visible, source, created_at_ms) VALUES
--     ('pn_page_app_version_read', 'page_app_version_read', 'page', 'group_app', 803, 'app', NULL, '版本(App)', 'Version (App)', NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
--     ('pn_page_mingci', 'page_mingci', 'page', 'group_app', 805, 'app', NULL, '名词', 'Nouns', NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
--   DELETE FROM ext_role_permissions WHERE permission_id IN
--     ('p_app_nav_read', 'p_app_style_read', 'p_app_chapter_read', 'p_app_content_read', 'p_app_fang_read', 'p_app_zhongyao_read');
--   DELETE FROM ext_permission_nodes WHERE code IN
--     ('app:nav:read', 'app:style:read', 'app:chapter:read', 'app:content:read', 'app:fang:read', 'app:zhongyao:read');
--   DELETE FROM ext_permissions WHERE code IN
--     ('app:nav:read', 'app:style:read', 'app:chapter:read', 'app:content:read', 'app:fang:read', 'app:zhongyao:read');
--   UPDATE ext_permission_nodes SET parent_code = 'page_app_version_read', sort = 0 WHERE code = 'app:version:read';
--   UPDATE ext_permission_nodes SET parent_code = 'page_mingci', sort = 0 WHERE code = 'app:mingci:view';
--   UPDATE ext_permission_nodes SET name_zh = '接入', name_en = 'Access' WHERE code = 'page_app_access';
--   UPDATE ext_permission_nodes SET name_zh = '搜索', name_en = 'Search' WHERE code = 'page_app_search';
--   UPDATE ext_permission_nodes SET name_zh = '公告(App)', name_en = 'Announcements (App)' WHERE code = 'page_app_announcement_read';

-- 1. 新权限码
INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_app_nav_read', 'app:nav:read', 'App 导航读取'),
  ('p_app_style_read', 'app:style:read', 'App 提示样式读取'),
  ('p_app_chapter_read', 'app:chapter:read', 'App 章节目录读取'),
  ('p_app_content_read', 'app:content:read', 'App 章节内容读取'),
  ('p_app_fang_read', 'app:fang:read', 'App 中药方剂读取'),
  ('p_app_zhongyao_read', 'app:zhongyao:read', 'App 中药读取');

-- 2. 新码叶子：挂在 page_app_access 下（app 端）
INSERT OR IGNORE INTO ext_permission_nodes
  (id, code, kind, parent_code, sort, audience, permission_code, name_zh, name_en, icon, i18n_key, is_visible, source, created_at_ms) VALUES
  ('pn_app_nav_read', 'app:nav:read', 'code', 'page_app_access', 0, 'app', 'app:nav:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_app_style_read', 'app:style:read', 'code', 'page_app_access', 1, 'app', 'app:style:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_app_chapter_read', 'app:chapter:read', 'code', 'page_app_access', 2, 'app', 'app:chapter:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_app_content_read', 'app:content:read', 'code', 'page_app_access', 3, 'app', 'app:content:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_app_fang_read', 'app:fang:read', 'code', 'page_app_access', 4, 'app', 'app:fang:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_app_zhongyao_read', 'app:zhongyao:read', 'code', 'page_app_access', 5, 'app', 'app:zhongyao:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- 3. 页面改名（单页口径的分类名），版本叶子并入 app访问
UPDATE ext_permission_nodes SET name_zh = 'app访问', name_en = 'App access' WHERE code = 'page_app_access';
UPDATE ext_permission_nodes SET name_zh = 'app搜索', name_en = 'App search' WHERE code = 'page_app_search';
UPDATE ext_permission_nodes SET name_zh = 'app公告', name_en = 'App announcements' WHERE code = 'page_app_announcement_read';
UPDATE ext_permission_nodes SET parent_code = 'page_app_access', sort = 6 WHERE code = 'app:version:read';
DELETE FROM ext_permission_nodes WHERE code = 'page_app_version_read';

-- 4. 名词叶子并入 app搜索（单页口径：搜索分类下含名词），随后删除空页
UPDATE ext_permission_nodes SET parent_code = 'page_app_search', sort = 2 WHERE code = 'app:mingci:view';
DELETE FROM ext_permission_nodes WHERE code = 'page_mingci';

-- 5. 授权等价映射：旧门持有者获得七个新码，再移除旧门的授权行
INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id)
  SELECT rp.role_id, 'p_app_nav_read' FROM ext_role_permissions rp WHERE rp.permission_id = 'p_app_mobile_access';
INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id)
  SELECT rp.role_id, 'p_app_style_read' FROM ext_role_permissions rp WHERE rp.permission_id = 'p_app_mobile_access';
INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id)
  SELECT rp.role_id, 'p_app_chapter_read' FROM ext_role_permissions rp WHERE rp.permission_id = 'p_app_mobile_access';
INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id)
  SELECT rp.role_id, 'p_app_content_read' FROM ext_role_permissions rp WHERE rp.permission_id = 'p_app_mobile_access';
INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id)
  SELECT rp.role_id, 'p_app_fang_read' FROM ext_role_permissions rp WHERE rp.permission_id = 'p_app_mobile_access';
INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id)
  SELECT rp.role_id, 'p_app_zhongyao_read' FROM ext_role_permissions rp WHERE rp.permission_id = 'p_app_mobile_access';
INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id)
  SELECT rp.role_id, 'p_app_mingci_view' FROM ext_role_permissions rp WHERE rp.permission_id = 'p_app_mobile_access';
DELETE FROM ext_role_permissions WHERE permission_id = 'p_app_mobile_access';

-- 6. 旧码退役：先删叶子，再删目录行
DELETE FROM ext_permission_nodes WHERE code = 'app:mobile:access';
DELETE FROM ext_permissions WHERE code IN ('app:mobile:access');

-- 7. 菜单回到单页口径。双控制台时期的菜单行（rbac 改名、rbac_app 新行）只在
-- 应用过旧版 0130 的库里存在；全新库本段自然为 no-op。恢复值取 0041 的原行：
-- 名字走 i18n 键 `menu.item.rbac`，守卫沿用 system:role:manage。
UPDATE ext_menu
  SET path = 'rbac',
      name_zh = NULL,
      name_en = NULL,
      i18n_key = 'menu.item.rbac',
      permission_code = 'system:role:manage'
  WHERE code = 'rbac';
DELETE FROM ext_menu WHERE code = 'rbac_app';
DELETE FROM ext_menu_permissions WHERE menu_code = 'rbac_app';
