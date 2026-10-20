-- 0129_data_regroup_app_permission_nodes.sql
--
-- 把 6 个 App 能力码从 PC 分组收拢到一个 App 根组下（ADR-0039 D5）。
--
-- 现状（迁移 0127 固化的形状）：6 个 App 码散在 PC 页下——
--   app:mobile:access        挂在「集成 → API」（page_api，混合页：还有 desktop 码）
--   app:version:read         「运营管理 → 版本(App)」（纯 App 合成页）
--   app:announcement:read    「运营管理 → 公告(App)」（纯 App 合成页）
--   app:mingci:view          「会员功能 → 名词」（纯 App 合成页）
--   app:search:book/global   「会员功能 → 搜索」（page_unmapped，混合页：还有 media 码）
--
-- 改后形状：
--   group_app（App 端）
--     page_app_access          接入      <- app:mobile:access
--     page_app_search          搜索      <- app:search:book / app:search:global
--     page_app_version_read    版本(App) <- app:version:read
--     page_app_announcement_read 公告(App) <- app:announcement:read
--     page_mingci              名词      <- app:mingci:view
--
-- 顺带收尾两处「名字不描述内容」的残留：
--   page_unmapped 里的 media:file:manage 迁到新建 page_media（内容组，桌面端），
--   随后删除 page_unmapped；page_mingci 迁走后 group_other 已空，一并删除。
--
-- 只动节点表，不改 ext_permissions（码本身的归属由节点叶子推导）与
-- ext_role_permissions（授权不受搬家影响，editor / readonly 仍持那 2 条 App 码）。
--
-- 幂等：新增行 INSERT OR IGNORE，改动行 UPDATE（重复执行结果相同），
-- 删除行按 code 删（第二次执行影响 0 行）。
--
-- rollback:
--   父行先补齐再改子行：本迁移正文明文删掉了 group_other / page_unmapped，
--   回滚里但凡有子行指向它们，这两条 INSERT 必须先跑，否则回滚后留下
--   parent_code 指向不存在父级的行（授权树整枝不可见）。
--   INSERT OR IGNORE INTO ext_permission_nodes (id, code, kind, parent_code, sort, audience, permission_code, name_zh, name_en, icon, i18n_key, is_visible, source, created_at_ms) VALUES
--     ('pn_group_other', 'group_other', 'group', NULL, 700, 'desktop', NULL, '会员功能', 'Membership features', NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
--     ('pn_page_unmapped', 'page_unmapped', 'page', 'group_other', 702, 'desktop', NULL, '搜索', 'Search', NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
--   DELETE FROM ext_permission_nodes WHERE code IN ('page_app_access', 'page_app_search', 'page_media', 'group_app');
--   UPDATE ext_permission_nodes SET parent_code = 'group_other', audience = 'desktop', sort = 701 WHERE code = 'page_mingci';
--   UPDATE ext_permission_nodes SET parent_code = 'group_operations', sort = 606 WHERE code = 'page_app_version_read';
--   UPDATE ext_permission_nodes SET parent_code = 'group_operations', sort = 607 WHERE code = 'page_app_announcement_read';
--   UPDATE ext_permission_nodes SET parent_code = 'page_api', sort = 0 WHERE code = 'app:mobile:access';
--   UPDATE ext_permission_nodes SET parent_code = 'page_unmapped', sort = 1 WHERE code = 'app:search:book';
--   UPDATE ext_permission_nodes SET parent_code = 'page_unmapped', sort = 2 WHERE code = 'app:search:global';
--   UPDATE ext_permission_nodes SET parent_code = 'page_unmapped', sort = 2 WHERE code = 'media:file:manage';
--   UPDATE ext_permission_nodes SET audience = 'desktop' WHERE code IN ('app:version:read', 'app:announcement:read', 'app:mingci:view');

-- 1. App 根组与两个新页
INSERT OR IGNORE INTO ext_permission_nodes
  (id, code, kind, parent_code, sort, audience, permission_code, name_zh, name_en, icon, i18n_key, is_visible, source, created_at_ms) VALUES
  ('pn_group_app', 'group_app', 'group', NULL, 800, 'app', NULL, 'App 端', 'App console', 'smartphone', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_app_access', 'page_app_access', 'page', 'group_app', 801, 'app', NULL, '接入', 'Access', 'smartphone', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pn_page_app_search', 'page_app_search', 'page', 'group_app', 802, 'app', NULL, '搜索', 'Search', 'eye', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- 2. 桌面端的媒体页（承接 media:file:manage，替代名不副实的 page_unmapped）
INSERT OR IGNORE INTO ext_permission_nodes
  (id, code, kind, parent_code, sort, audience, permission_code, name_zh, name_en, icon, i18n_key, is_visible, source, created_at_ms) VALUES
  ('pn_page_media', 'page_media', 'page', 'group_content', 111, 'desktop', NULL, '媒体文件', 'Media files', 'image', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- 3. 三个纯 App 合成页改父到 group_app，并置 audience
UPDATE ext_permission_nodes SET parent_code = 'group_app', sort = 803, audience = 'app'
  WHERE code = 'page_app_version_read';
UPDATE ext_permission_nodes SET parent_code = 'group_app', sort = 804, audience = 'app'
  WHERE code = 'page_app_announcement_read';
UPDATE ext_permission_nodes SET parent_code = 'group_app', sort = 805, audience = 'app'
  WHERE code = 'page_mingci';

-- 4. 6 个 App 码叶子改父 + 置 audience
UPDATE ext_permission_nodes SET parent_code = 'page_app_access', sort = 0, audience = 'app'
  WHERE code = 'app:mobile:access';
UPDATE ext_permission_nodes SET parent_code = 'page_app_search', sort = 0, audience = 'app'
  WHERE code = 'app:search:book';
UPDATE ext_permission_nodes SET parent_code = 'page_app_search', sort = 1, audience = 'app'
  WHERE code = 'app:search:global';
UPDATE ext_permission_nodes SET audience = 'app'
  WHERE code IN ('app:version:read', 'app:announcement:read', 'app:mingci:view');

-- 5. 混合页收窄：page_api 只留 system:api:manage；media:file:manage 迁到 page_media
UPDATE ext_permission_nodes SET parent_code = 'page_media', sort = 0
  WHERE code = 'media:file:manage';
UPDATE ext_permission_nodes SET sort = 0
  WHERE code = 'system:api:manage';

-- 6. 删除移空的兜底页与分组（先删页，再删组，避免留孤儿）
--    `group_other` 只在确实没有子行时删除：管理页允许自建分组，若有人把它挂在
--    兜底组下，直接删会让那几行失去父级（渲染时整枝不见）。
DELETE FROM ext_permission_nodes WHERE code = 'page_unmapped';
DELETE FROM ext_permission_nodes
  WHERE code = 'group_other'
    AND NOT EXISTS (
      SELECT 1 FROM ext_permission_nodes child WHERE child.parent_code = 'group_other'
    );
