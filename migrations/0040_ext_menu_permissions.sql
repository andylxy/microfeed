-- 0040_ext_menu_permissions.sql
--
-- Permission codes the admin menu binds to. Every menu row carries an optional
-- permission code: a row with one is visible only to accounts that hold it, a
-- row without one is a public menu (visible to anyone signed in). Six menu
-- destinations had no code to bind, so they get one here:
--   content:channel:manage  -> channel settings
--   content:review:manage   -> review queue
--   content:audit:read      -> audit
--   content:page:manage     -> pages
--   content:site_file:manage-> site files
--   system:api:manage       -> the API area of the dashboard
--
-- `system:api:manage` is deliberately NOT one of the `api:*` codes: those gate
-- what a signed API call may read or write, while this one gates who may open
-- the API area of the dashboard at all.
--
-- The editor role also gains the content-domain codes it needs to reach the
-- pages its menus now bind to (articles, pages, site files). It deliberately
-- does not gain `content:article:delete`, nor the governance codes above.
--
-- Idempotent (`INSERT OR IGNORE`) so re-applying migrations is safe. The code
-- catalog in `src/server/rbac/seed.ts` mirrors these exactly; a worker test
-- asserts the two stay in sync.

INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_content_channel_manage',   'content:channel:manage',   '频道设置管理'),
  ('p_content_review_manage',    'content:review:manage',    '审核管理'),
  ('p_content_audit_read',       'content:audit:read',       '审计查看'),
  ('p_content_page_manage',      'content:page:manage',      '页面管理'),
  ('p_content_site_file_manage', 'content:site_file:manage', '站点文件管理'),
  ('p_system_api_manage',        'system:api:manage',        'API 管理');

-- editor: reach the content menus. Review, audit, channel and API stay
-- admin-only (not granted here). super_admin covers everything via the `*`
-- wildcard already seeded in 0031.
INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id) VALUES
  ('r_editor', 'p_content_article_read'),
  ('r_editor', 'p_content_article_create'),
  ('r_editor', 'p_content_article_update'),
  ('r_editor', 'p_content_page_manage'),
  ('r_editor', 'p_content_site_file_manage');
