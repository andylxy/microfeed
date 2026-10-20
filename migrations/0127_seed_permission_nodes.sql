-- 0127_seed_permission_nodes.sql
--
-- 权限树自持（ADR-0038）：把当前由 ext_menu + ext_menu_permissions 派生的权限
-- 树固化成 ext_permission_nodes 节点行。此后角色编辑器与权限树管理页只读这张表。
--
-- 行数：87 = 7 分组 + 29 页面 + 51 权限码。
-- 生成方式：一次性生成器 .scratch/permission-tree-self-hosted/gen-nodes.mts
--   （逐字复刻 readRbacBoard + buildPermissionTree 的派生结果，非手写）。
-- 核对：45 条旧映射 distinct 权限码零丢失、零多出；51 个可授码全部有挂靠点。
--
-- id 规则（对偶 permissionId() 的 p_ 前缀）：
--   group 节点 code = 菜单分组 code；page 节点 code = page_<派生页 code>；
--   code 节点 code = 权限码本身。id = pn_<code 冒号换下划线>。
--
-- 名称（决策 6，不借菜单文案键）：组/页的中英文名取 i18n 当前文本作为冗余列，
--   权限树与菜单解耦；code 节点的 name_zh/name_en 留空，渲染时取 ext_permissions.name。
--
-- 类型 seed：豁免 MIG-004 回滚块要求（与 0123/0126 同款），故不写 -- rollback: 块。
-- 幂等：全部 INSERT OR IGNORE，重复执行安全。

CREATE TABLE IF NOT EXISTS ext_permission_nodes (
  id              TEXT PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL,           -- 'group' | 'page' | 'code'
  parent_code     TEXT,                     -- NULL = 根层
  sort            INTEGER NOT NULL DEFAULT 0,
  permission_code TEXT,                     -- kind='code' 时非空，且不可变
  name_zh         TEXT,
  name_en         TEXT,
  icon            TEXT,
  i18n_key        TEXT,
  is_visible      INTEGER NOT NULL DEFAULT 1,
  source          TEXT NOT NULL,           -- 'seed' | 'custom'
  created_at_ms   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_ext_permission_nodes_parent ON ext_permission_nodes (parent_code);
CREATE INDEX IF NOT EXISTS ix_ext_permission_nodes_sort   ON ext_permission_nodes (sort, code);
CREATE INDEX IF NOT EXISTS ix_ext_permission_nodes_kind   ON ext_permission_nodes (kind);

-- 固化行（source='seed'）。
INSERT OR IGNORE INTO ext_permission_nodes
  (id, code, kind, parent_code, sort, permission_code, name_zh, name_en, icon, i18n_key, is_visible, source, created_at_ms) VALUES
  ('pn_group_content', 'group_content', 'group', NULL, 100, NULL, '内容', 'Content', 'book', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_books', 'page_books', 'page', 'group_content', 101, NULL, '书籍', 'Books', 'book', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_book_create', 'content:book:create', 'code', 'page_books', 0, 'content:book:create', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_book_delete', 'content:book:delete', 'code', 'page_books', 1, 'content:book:delete', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_book_read', 'content:book:read', 'code', 'page_books', 2, 'content:book:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_book_update', 'content:book:update', 'code', 'page_books', 3, 'content:book:update', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_volumes', 'page_volumes', 'page', 'group_content', 102, NULL, '卷章管理', 'Volume board', 'layers', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_volume_read', 'content:volume:read', 'code', 'page_volumes', 0, 'content:volume:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_volume_update', 'content:volume:update', 'code', 'page_volumes', 1, 'content:volume:update', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_categories', 'page_categories', 'page', 'group_content', 103, NULL, '题材分类', 'Categories', 'tags', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_category_create', 'content:category:create', 'code', 'page_categories', 0, 'content:category:create', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_category_delete', 'content:category:delete', 'code', 'page_categories', 1, 'content:category:delete', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_category_order', 'content:category:order', 'code', 'page_categories', 2, 'content:category:order', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_category_read', 'content:category:read', 'code', 'page_categories', 3, 'content:category:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_category_update', 'content:category:update', 'code', 'page_categories', 4, 'content:category:update', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_all_items', 'page_all_items', 'page', 'group_content', 104, NULL, '查看全部条目', 'See all items', 'list', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_chapter_create', 'content:chapter:create', 'code', 'page_all_items', 0, 'content:chapter:create', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_chapter_delete', 'content:chapter:delete', 'code', 'page_all_items', 1, 'content:chapter:delete', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_chapter_read', 'content:chapter:read', 'code', 'page_all_items', 2, 'content:chapter:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_chapter_update', 'content:chapter:update', 'code', 'page_all_items', 3, 'content:chapter:update', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_annotation_markers', 'page_annotation_markers', 'page', 'group_content', 106, NULL, '标注标记', 'Annotation markers', 'tags', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_annotation-markers_manage', 'content:annotation-markers:manage', 'code', 'page_annotation_markers', 0, 'content:annotation-markers:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_annotation-markers_read', 'content:annotation-markers:read', 'code', 'page_annotation_markers', 1, 'content:annotation-markers:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_fangs', 'page_fangs', 'page', 'group_content', 107, NULL, '方剂管理', 'Formulas', 'pill', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_fang_read', 'content:fang:read', 'code', 'page_fangs', 0, 'content:fang:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_aliases', 'page_aliases', 'page', 'group_content', 108, NULL, '别名对照', 'Aliases', 'list', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_alias_manage', 'content:alias:manage', 'code', 'page_aliases', 0, 'content:alias:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_alias_read', 'content:alias:read', 'code', 'page_aliases', 1, 'content:alias:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_yao', 'page_yao', 'page', 'group_content', 109, NULL, '中药管理', 'Herbs', 'leaf', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_yao_manage', 'content:yao:manage', 'code', 'page_yao', 0, 'content:yao:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_yao_read', 'content:yao:read', 'code', 'page_yao', 1, 'content:yao:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_term', 'page_term', 'page', 'group_content', 110, NULL, '名词管理', 'Terms', 'tags', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_term_manage', 'content:term:manage', 'code', 'page_term', 0, 'content:term:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_term_read', 'content:term:read', 'code', 'page_term', 1, 'content:term:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_group_review', 'group_review', 'group', NULL, 200, NULL, '审核', 'Review', 'shield-check', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_review', 'page_review', 'page', 'group_review', 201, NULL, '审核队列', 'Review queue', 'shield-check', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_review_manage', 'content:review:manage', 'code', 'page_review', 0, 'content:review:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_audit', 'page_audit', 'page', 'group_review', 202, NULL, '修改留痕', 'Audit trail', 'history', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_audit_read', 'content:audit:read', 'code', 'page_audit', 0, 'content:audit:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_group_site', 'group_site', 'group', NULL, 300, NULL, '站点', 'Site', 'settings', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_edit_channel', 'page_edit_channel', 'page', 'group_site', 301, NULL, '编辑频道', 'Edit channel', 'pencil', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_channel_manage', 'content:channel:manage', 'code', 'page_edit_channel', 0, 'content:channel:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_pages', 'page_pages', 'page', 'group_site', 302, NULL, '页面', 'Pages', 'file-text', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_page_manage', 'content:page:manage', 'code', 'page_pages', 0, 'content:page:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_site_files', 'page_site_files', 'page', 'group_site', 303, NULL, '站点文件', 'Site files', 'file-code-2', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_site_file_manage', 'content:site_file:manage', 'code', 'page_site_files', 0, 'content:site_file:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_settings', 'page_settings', 'page', 'group_site', 304, NULL, '设置', 'Settings', 'settings', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_content_settings_manage', 'content:settings:manage', 'code', 'page_settings', 0, 'content:settings:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_group_integration', 'group_integration', 'group', NULL, 400, NULL, '集成', 'Integrations', 'code-2', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_api', 'page_api', 'page', 'group_integration', 401, NULL, 'API', 'API', 'code-2', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_app_mobile_access', 'app:mobile:access', 'code', 'page_api', 0, 'app:mobile:access', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_system_api_manage', 'system:api:manage', 'code', 'page_api', 1, 'system:api:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_webhooks', 'page_webhooks', 'page', 'group_integration', 402, NULL, 'Webhook', 'Webhooks', 'webhook', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_system_webhook_manage', 'system:webhook:manage', 'code', 'page_webhooks', 0, 'system:webhook:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_group_account', 'group_account', 'group', NULL, 500, NULL, '账户', 'Account', 'users', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_rbac', 'page_rbac', 'page', 'group_account', 501, NULL, '角色与权限', 'Roles & permissions', 'shield-check', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_system_role_manage', 'system:role:manage', 'code', 'page_rbac', 0, 'system:role:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_users', 'page_users', 'page', 'group_account', 502, NULL, '用户', 'Users', 'users', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_system_user_manage', 'system:user:manage', 'code', 'page_users', 0, 'system:user:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_menu_management', 'page_menu_management', 'page', 'group_account', 503, NULL, '菜单管理', 'Menu management', 'list', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_system_menu_manage', 'system:menu:manage', 'code', 'page_menu_management', 0, 'system:menu:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_group_operations', 'group_operations', 'group', NULL, 600, NULL, '运营管理', 'Operations', 'activity', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_devices', 'page_devices', 'page', 'group_operations', 601, NULL, '设备管理', 'Devices', 'smartphone', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_system_device_manage', 'system:device:manage', 'code', 'page_devices', 0, 'system:device:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_system_device_read', 'system:device:read', 'code', 'page_devices', 1, 'system:device:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_app_versions', 'page_app_versions', 'page', 'group_operations', 602, NULL, '版本管理', 'App versions', 'download', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_system_app-version_manage', 'system:app-version:manage', 'code', 'page_app_versions', 0, 'system:app-version:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_system_app-version_read', 'system:app-version:read', 'code', 'page_app_versions', 1, 'system:app-version:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_login_logs', 'page_login_logs', 'page', 'group_operations', 603, NULL, '登录日志', 'Login log', 'history', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_system_login-log_manage', 'system:login-log:manage', 'code', 'page_login_logs', 0, 'system:login-log:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_system_login-log_read', 'system:login-log:read', 'code', 'page_login_logs', 1, 'system:login-log:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_announcements', 'page_announcements', 'page', 'group_operations', 604, NULL, '公告管理', 'Announcements', 'file-text', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_system_announcement_manage', 'system:announcement:manage', 'code', 'page_announcements', 0, 'system:announcement:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_system_announcement_read', 'system:announcement:read', 'code', 'page_announcements', 1, 'system:announcement:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_cloud_usage', 'page_cloud_usage', 'page', 'group_operations', 605, NULL, '使用情况', 'Cloud usage', 'database', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_system_cloud-usage_read', 'system:cloud-usage:read', 'code', 'page_cloud_usage', 0, 'system:cloud-usage:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_app_version_read', 'page_app_version_read', 'page', 'group_operations', 606, NULL, '版本(App)', 'Version (App)', NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_app_version_read', 'app:version:read', 'code', 'page_app_version_read', 0, 'app:version:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_app_announcement_read', 'page_app_announcement_read', 'page', 'group_operations', 607, NULL, '公告(App)', 'Announcements (App)', NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_app_announcement_read', 'app:announcement:read', 'code', 'page_app_announcement_read', 0, 'app:announcement:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_group_other', 'group_other', 'group', NULL, 700, NULL, '会员功能', 'Membership features', NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_mingci', 'page_mingci', 'page', 'group_other', 701, NULL, '名词', 'Noun terms', NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_app_mingci_view', 'app:mingci:view', 'code', 'page_mingci', 0, 'app:mingci:view', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_unmapped', 'page_unmapped', 'page', 'group_other', 702, NULL, '搜索', 'Search', NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_app_search_book', 'app:search:book', 'code', 'page_unmapped', 0, 'app:search:book', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_app_search_global', 'app:search:global', 'code', 'page_unmapped', 1, 'app:search:global', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_media_file_manage', 'media:file:manage', 'code', 'page_unmapped', 2, 'media:file:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
