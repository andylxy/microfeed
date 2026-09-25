-- 0065_ext_drop_rbac_permissions_page.sql
--
-- Drops the second RBAC board page and merges its permission code back into
-- `system:role:manage`. See `.scratch/microfeed-rbac/adr/0002-one-rbac-board.md`.
--
-- 0061 added the `rbac_permissions` menu row and the `/rbac/permissions/` page
-- so an account holding only `system:permission:manage` had somewhere to land
-- (B27). The two pages were the same screen: both rendered `RbacApp` over
-- `readRbacBoard`, differing only in the guard code, the active menu item and
-- the title. The split never produced a usable half-administrator either — the
-- board is one screen, so a holder of a single code could open it and then hit
-- 403 on half its buttons: role CRUD endpoints require `system:role:manage`,
-- the grant-save endpoint required `system:permission:manage`.
--
-- Consequence of the merge: `POST /ajax/rbac/role-permissions` now requires
-- `system:role:manage`, the same code every other RBAC endpoint uses. There is
-- no "grants-only administrator" shape left; that was never granted to any role
-- (zero `ext_role_permissions` rows for both codes on the live instance — the
-- only holder is `super_admin`, through the `*` wildcard, which loses nothing).
--
-- Also removes every `ext_menu_permissions` row that carries the retired code,
-- plus `('rbac_audit', 'system:role:manage')`. 0064 already deleted the two tree
-- rows 0063 duplicated; that one is repeated here so this migration is complete
-- on its own, and the overlap is harmless — both are absolute DELETEs.
--
-- Idempotent: every statement is a DELETE, a no-op once the rows are gone.

DELETE FROM ext_role_permissions
 WHERE permission_id = 'p_system_permission_manage';

DELETE FROM ext_menu_permissions
 WHERE permission_code = 'system:permission:manage'
    OR (menu_code = 'rbac_audit' AND permission_code = 'system:role:manage');

-- `IN (…)` rather than `code = …`: `tests/unit/admin-endpoint-guards.test.ts`
-- parses the catalog out of these files and understands the `IN` / `LIKE` forms.
DELETE FROM ext_permissions
 WHERE code IN ('system:permission:manage');

DELETE FROM ext_menu
 WHERE code = 'rbac_permissions';

-- 0061 pushed `users` from 502 to 503 to make room for the row above.
UPDATE ext_menu SET sort = 502 WHERE code = 'users' AND sort = 503;
