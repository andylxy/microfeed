-- 0069_ext_annotation_markers_menu_map.sql
--
-- Follow-up to 0068, fixing two integration gaps:
--
-- A. Permission row ids: `permissionId()` in seed.ts derives ids from the code
--    by replacing ONLY the colons — so the derived id for
--    `content:annotation-markers:read` is `p_content_annotation-markers_read`
--    (hyphen kept). 0068 hand-wrote underscore ids
--    (`p_content_annotation_markers_read`) while the UNIQUE `code` column made
--    seedRbac's INSERT OR IGNORE a no-op for those codes — the grant loop then
--    referenced the derived id, which did not exist, and the FOREIGN KEY
--    failure made every fresh `bootstrapAdmin` 500. Rebuild the two rows under
--    the derived ids (plain DELETE + re-INSERT: no ext_role_permissions rows
--    reference the old ids yet, and ext_menu_permissions stores the code
--    string, not the id).
--
-- B. Menu-tree visibility: the annotation-markers page was invisible in the
--    role editor's permission tree, so no role below super_admin could be
--    granted the codes — an account without `content:annotation-markers:read`
--    gets a 403 on the editor's marker-list fetch and silently falls back to
--    the four seed buttons (a newly added marker like `$y 测试` never shows).
--    Re-parent the menu row under `group_content` (0050 pattern), map both
--    codes in `ext_menu_permissions` (0063 pattern), and grant `:read` to the
--    `editor` and `readonly` roles (0043 seed pattern). `:manage` stays with
--    super_admin unless granted explicitly from the role editor.
--
-- Idempotent throughout.

-- A. Re-align the permission row ids with permissionId().
DELETE FROM ext_permissions
  WHERE id IN ('p_content_annotation_markers_read', 'p_content_annotation_markers_manage');

INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_content_annotation-markers_read',   'content:annotation-markers:read',   '标注标记查看'),
  ('p_content_annotation-markers_manage', 'content:annotation-markers:manage', '标注标记管理');

-- B1. Re-parent the menu row: 内容 group, after 导入章节 (sort 105).
UPDATE ext_menu SET parent_code = 'group_content', sort = 106
WHERE code = 'annotation_markers';

-- B2. Menu → permission map: both codes assignable from the role editor.
INSERT OR IGNORE INTO ext_menu_permissions (menu_code, permission_code) VALUES
  ('annotation_markers', 'content:annotation-markers:manage'),
  ('annotation_markers', 'content:annotation-markers:read');

-- B3. Grant :read to the content roles (guarded, idempotent). The ids here
--     MUST be the permissionId() derivation, or the FK fails again.
INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id)
  SELECT 'r_editor', 'p_content_annotation-markers_read'
  WHERE EXISTS (SELECT 1 FROM ext_roles WHERE id = 'r_editor')
    AND EXISTS (SELECT 1 FROM ext_permissions WHERE id = 'p_content_annotation-markers_read');

INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id)
  SELECT 'r_readonly', 'p_content_annotation-markers_read'
  WHERE EXISTS (SELECT 1 FROM ext_roles WHERE id = 'r_readonly')
    AND EXISTS (SELECT 1 FROM ext_permissions WHERE id = 'p_content_annotation-markers_read');
