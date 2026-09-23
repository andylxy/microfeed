-- 0050_ext_menu_groups.sql
--
-- The admin menu shipped flat (0041): every row was a top-level link. This
-- migration turns it into a two-level tree by adding five *group* rows and
-- pointing the existing pages at them via `parent_code` (the column already
-- existed; nothing used it).
--
-- A group row is a heading, not a link:
--   path = ''            -> nothing to navigate to
--   permission_code NULL -> public, exactly like the home row; a group is
--                           shown only while it still has a visible child,
--                           because `readAdminMenu` prunes empty parents.
-- A group deliberately binds no permission of its own: the children decide
-- whether the heading survives, so an account never sees an empty section.
--
-- Codes are prefixed `group_` because `ext_menu.code` is UNIQUE and the page
-- codes (`review`, `settings`, …) are already taken.
--
-- Idempotent: `INSERT OR IGNORE` for the rows, absolute `UPDATE`s for the
-- re-parenting, so re-applying is safe.

INSERT OR IGNORE INTO ext_menu
  (id, code, parent_code, path, i18n_key, icon, permission_code, sort, is_visible, created_at_ms)
VALUES
  ('m_group_content',     'group_content',     NULL, '', 'menu.group.content',     NULL, NULL, 100, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('m_group_review',      'group_review',      NULL, '', 'menu.group.review',      NULL, NULL, 200, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('m_group_site',        'group_site',        NULL, '', 'menu.group.site',        NULL, NULL, 300, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('m_group_integration', 'group_integration', NULL, '', 'menu.group.integration', NULL, NULL, 400, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('m_group_account',     'group_account',     NULL, '', 'menu.group.account',     NULL, NULL, 500, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- 内容：书 / 卷 / 分类 / 章节 / 导入
UPDATE ext_menu SET parent_code = 'group_content', sort = 101 WHERE code = 'books';
UPDATE ext_menu SET parent_code = 'group_content', sort = 102 WHERE code = 'volumes';
UPDATE ext_menu SET parent_code = 'group_content', sort = 103 WHERE code = 'categories';
UPDATE ext_menu SET parent_code = 'group_content', sort = 104 WHERE code = 'all_items';
UPDATE ext_menu SET parent_code = 'group_content', sort = 105 WHERE code = 'import_chapters';

-- 审核：审核队列 / 审计
UPDATE ext_menu SET parent_code = 'group_review', sort = 201 WHERE code = 'review';
UPDATE ext_menu SET parent_code = 'group_review', sort = 202 WHERE code = 'audit';

-- 站点：频道 / 页面 / 站点文件 / 设置
UPDATE ext_menu SET parent_code = 'group_site', sort = 301 WHERE code = 'edit_channel';
UPDATE ext_menu SET parent_code = 'group_site', sort = 302 WHERE code = 'pages';
UPDATE ext_menu SET parent_code = 'group_site', sort = 303 WHERE code = 'site_files';
UPDATE ext_menu SET parent_code = 'group_site', sort = 304 WHERE code = 'settings';

-- 集成：API / Webhook
UPDATE ext_menu SET parent_code = 'group_integration', sort = 401 WHERE code = 'api';
UPDATE ext_menu SET parent_code = 'group_integration', sort = 402 WHERE code = 'webhooks';

-- 账户：角色 / 用户
UPDATE ext_menu SET parent_code = 'group_account', sort = 501 WHERE code = 'rbac';
UPDATE ext_menu SET parent_code = 'group_account', sort = 502 WHERE code = 'users';

-- 首页保持顶层独立（sort 10，parent_code NULL，由 0041 播种）。
