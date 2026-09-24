-- 0057_rename_article_permission_codes.sql
--
-- ADR-0006 follow-up: rename the RBAC codes `content:article:*` →
-- `content:chapter:*`, so the permission codes agree with the `chapters` path
-- segment of the content read API. (The third name — upstream's `items`
-- endpoints — is upstream's and is not touched.)
--
-- The seed definition (0031) and menu bindings (0040/0041/0043/0052) were
-- renamed in place at the same time, so a FRESH database seeds the chapter
-- codes directly and this migration is a no-op there. This file exists to
-- migrate databases that applied 0031 before the rename (i.e. production).
--
-- Pure rename, zero behaviour change: every role/menu that referenced the old
-- codes is repointed here, so nothing loses or gains access.
--
-- Mechanics that must be true for this migration:
--   * `ext_permissions.code` is UNIQUE and its `id` is DERIVED from the code
--     (`permissionId()` returns `p_<code with ':' → '_'>`), so the id must move
--     with the code or role grants would orphan.
--   * `ext_role_permissions.permission_id` has a FOREIGN KEY onto
--     `ext_permissions(id)` with ON DELETE CASCADE but NO ON UPDATE clause —
--     so it is impossible to UPDATE either side first: repointing the children
--     to ids that do not exist yet, or renaming the parent key while children
--     reference the old value, both trip SQLITE_CONSTRAINT_FOREIGNKEY.
--     Hence the insert-new-then-delete-old shape below, which stays inside the
--     constraint the whole way.
--   * `ext_menu_permissions` stores the code string itself.
-- There are no existing `content:chapter:*` rows to collide with.

-- 1) Copy the four permissions to their new ids and codes.
INSERT INTO ext_permissions (id, code, name)
SELECT REPLACE(id, 'p_content_article_', 'p_content_chapter_'),
       REPLACE(code, 'content:article:', 'content:chapter:'),
       name
  FROM ext_permissions
 WHERE code LIKE 'content:article:%';

-- 2) Copy the role grants onto the new ids.
INSERT INTO ext_role_permissions (role_id, permission_id)
SELECT role_id, REPLACE(permission_id, 'p_content_article_', 'p_content_chapter_')
  FROM ext_role_permissions
 WHERE permission_id LIKE 'p_content_article_%';

-- 3) Repoint menu bindings (stored as code strings).
UPDATE ext_menu_permissions
   SET permission_code = REPLACE(permission_code, 'content:article:', 'content:chapter:')
 WHERE permission_code LIKE 'content:article:%';

-- 4) Drop the old rows; ON DELETE CASCADE clears the now-stale role grants.
DELETE FROM ext_permissions WHERE code LIKE 'content:article:%';
