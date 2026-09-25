-- 0064_ext_menu_permissions_dedupe.sql
--
-- Correction to 0063. `ext_menu_permissions` is the permission *tree* map: it
-- says which menu page hosts which assignable code, and the tree invariant is
-- that **every catalogue code appears exactly once** (enforced by
-- `tests/worker/rbac.test.ts` → "every catalogue code but `*` appears in the
-- tree exactly once").
--
-- 0052 already mapped both of these codes to the `rbac` page:
--   ('rbac', 'system:role:manage')       -- line 64
--   ('rbac', 'system:permission:manage') -- line 65
--
-- 0063 then added two rows that duplicated them under the new menu rows, which
-- broke the invariant (the flattened tree carried each code twice). Menu
-- *visibility* comes from `ext_menu.permission_code` — that is what 0061/0062
-- were for — the tree map did not need touching at all. Remove the duplicates.
--
-- 0063's third row, ('rbac', 'system:permission:manage'), was an INSERT OR IGNORE
-- no-op and is left alone.
--
-- Idempotent: absolute DELETEs.

DELETE FROM ext_menu_permissions
WHERE (menu_code = 'rbac_permissions' AND permission_code = 'system:permission:manage')
   OR (menu_code = 'rbac_audit' AND permission_code = 'system:role:manage');
