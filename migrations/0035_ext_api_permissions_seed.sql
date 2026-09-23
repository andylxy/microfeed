-- 0035_ext_api_permissions_seed.sql
--
-- Permission catalog for the signed API call path. These codes are what the
-- signed-call gate checks (via `ext_user_roles` → `ext_role_permissions` →
-- `ext_permissions`), so the API key is purely an *identity* credential and
-- authorization is delegated to the existing RBAC system.
--
-- Idempotent (`INSERT OR IGNORE`) so re-applying migrations is safe. The code
-- catalog in `src/server/rbac/seed.ts` mirrors these exactly; a worker test
-- asserts the two stay in sync.

INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_api_content_read',  'api:content:read',  'API 内容读取'),
  ('p_api_content_write', 'api:content:write', 'API 内容写入'),
  ('p_api_media_read',    'api:media:read',    'API 媒体读取'),
  ('p_api_media_write',   'api:media:write',   'API 媒体写入'),
  ('p_api_page_read',     'api:page:read',     'API 页面读取'),
  ('p_api_page_write',    'api:page:write',    'API 页面写入'),
  ('p_api_site_read',     'api:site:read',     'API 站点文件读取'),
  ('p_api_site_write',    'api:site:write',    'API 站点文件写入');

-- An editor may use the API for content + media; Pages and Site Files stay
-- admin-only (not granted here). super_admin covers everything via the `*`
-- wildcard already seeded in 0031.
INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id) VALUES
  ('r_editor', 'p_api_content_read'),
  ('r_editor', 'p_api_content_write'),
  ('r_editor', 'p_api_media_read'),
  ('r_editor', 'p_api_media_write');
