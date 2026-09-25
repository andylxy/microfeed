-- 0063_ext_menu_rbac_permission_map.sql
--
-- B27/C3 follow-up: 0061 and 0062 added the `rbac_permissions` and `rbac_audit`
-- menu rows to `ext_menu`, but the menu → permission *map* (`ext_menu_permissions`,
-- 0052) was not updated. That map is what the role editor's permission tree
-- reads, so without these rows the two codes fell into the "other permissions"
-- bucket — and `tests/unit/admin-page-guards.test.ts` (which derives the bound
-- codes from the seeded menu rows) could not see them either.
--
-- Same codes the menu rows bind and their pages guard with:
--   rbac_permissions -> system:permission:manage
--   rbac_audit       -> system:role:manage
--
-- Idempotent: INSERT OR IGNORE.

INSERT OR IGNORE INTO ext_menu_permissions (menu_code, permission_code) VALUES
  ('rbac_permissions', 'system:permission:manage'),
  ('rbac_audit',       'system:role:manage'),
  -- The role board itself also edits grants, so its menu row maps both codes —
  -- the tree needs the permission-management entry under the RBAC section.
  ('rbac',             'system:permission:manage');
