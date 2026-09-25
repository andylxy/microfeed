-- 0058_ext_media_file_permission.sql
--
-- A1 fix (api-permissions.ts / credential-bearer.ts): the upstream-owned
-- `media_files` API domain previously had no RBAC rule, so `requiredApiPermission`
-- returned null and any login credential (`mflc_…`) could mint upload presigned
-- URLs with no code at all. This migration introduces the `media:file:manage`
-- code that guards that domain.
--
-- To avoid breaking existing credentials, every role that already holds
-- `content:site_file:manage` is also granted `media:file:manage` — the two are
-- the same operator audience (someone who may push files to the site). A role
-- that holds neither keeps being denied, which is the intended secure default.
--
-- Idempotent (safe to replay on D1, which may re-run migrations):
--   * `ext_permissions.code` is UNIQUE and its `id` is DERIVED from the code
--     (`permissionId()` → `p_<code with ':' → '_'>`), so the literal ids below
--     match the code-side catalog in `src/server/rbac/seed.ts`.
--   * The role-grant copy uses `INSERT OR IGNORE` plus a `NOT EXISTS` guard so a
--     re-run neither duplicates a row nor touches roles that already have it.

-- 1) Register the new permission code (id mirrors `permissionId('media:file:manage')`).
INSERT OR IGNORE INTO ext_permissions (id, code, name)
VALUES ('p_media_file_manage', 'media:file:manage', '媒体文件管理');

-- 2) Grant it to every role that already holds `content:site_file:manage`
--    (id mirrors `permissionId('content:site_file:manage')` = `p_content_site_file_manage`).
INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id)
SELECT role_id, 'p_media_file_manage'
  FROM ext_role_permissions
 WHERE permission_id = 'p_content_site_file_manage'
   AND NOT EXISTS (
     SELECT 1 FROM ext_role_permissions AS existing
      WHERE existing.role_id = ext_role_permissions.role_id
        AND existing.permission_id = 'p_media_file_manage'
   );
