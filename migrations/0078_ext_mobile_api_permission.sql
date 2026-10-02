-- 0078_ext_mobile_api_permission.sql
--
-- 「移动端权限」— the mobile app's API access gate. It appears as a leaf in the
-- role editor's permission tree under 集成 → API (the `api` page), so an admin
-- can tick it to let a role's account call the `/api/AppBookRequest/*` mobile
-- endpoints. This is the user → role → permissions path: the App logs in as a
-- microfeed user and carries that user's login credential (`mflc_…`).
--
-- The code is `app:mobile:access`, NOT an `api:*` code: ADR-0009 retired the
-- whole `api:*` prefix family (migration 0055 does `DELETE … code LIKE 'api:%'`,
-- and API authorization reuses `content:*:*`). A new `api:*` code would
-- reintroduce the retired family and be swept away by any future `LIKE 'api:%'`
-- cleanup.
--
-- Catalog triple-mirror: `PERMISSION_CODES` (src/shared/Constants.ts) ≡
-- `RBAC_PERMISSIONS` (src/server/rbac/seed.ts) ≡ this SQL, pinned by
-- `tests/unit/admin-endpoint-guards.test.ts` and `tests/worker/rbac.test.ts`.
-- The id must be `permissionId()`-derived (`p_<code 冒号转下划线>`), otherwise
-- `bootstrapAdmin`'s grant INSERT 500s on the missing FK (0069 lesson).
--
-- Tree placement uses the 0052/0063 map (`ext_menu_permissions`): the `api`
-- page (集成 group) already hosts `system:api:manage`, so the code renders there
-- as a leaf instead of falling into the catch-all "其他权限" group.
--
-- Idempotent (`INSERT OR IGNORE`).

-- 1. Permission catalogue.
INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_app_mobile_access', 'app:mobile:access', '移动端权限');

-- 2. Tree map: host the code on the `api` page so it renders as a leaf in the
--    role editor instead of falling into the catch-all "其他权限" group.
INSERT OR IGNORE INTO ext_menu_permissions (menu_code, permission_code) VALUES
  ('api', 'app:mobile:access');

-- 3. Defensive cleanup: an earlier draft of this migration (0078_ext_mobile_role)
--    seeded a standalone `mobile` role, which is NOT the chosen design. Remove it
--    if that draft ever ran (a no-op otherwise). No other role is touched.
DELETE FROM ext_role_permissions WHERE role_id = 'r_mobile';
DELETE FROM ext_roles WHERE id = 'r_mobile';
