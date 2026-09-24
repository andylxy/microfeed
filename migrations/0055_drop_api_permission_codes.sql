-- 0055_drop_api_permission_codes.sql
--
-- ADR-0009: retire the `api:*` permission family.
--
-- API authorization now reuses the dashboard's own RBAC codes (`content:*:*`),
-- so these eight codes are dead: no role was ever granted one (only the
-- super_admin `*` wildcard passed the check), and `requiredApiPermission` no
-- longer returns them. See ADR-0008 (signed-call removal) and ADR-0009.
--
-- The `api` menu row keeps its `system:api:manage` binding, so the menu's
-- visibility is unchanged — only the eight `api:*` bindings go.
--
-- The `api:%` pattern cannot catch `system:api:manage` (a different prefix) nor
-- any `content:*:*` code, so it retires exactly the intended family.
--
-- Idempotent: deleting rows that are already absent is a no-op.

DELETE FROM ext_role_permissions
WHERE permission_id IN (
  SELECT id FROM ext_permissions WHERE code LIKE 'api:%'
);

DELETE FROM ext_menu_permissions WHERE permission_code LIKE 'api:%';

DELETE FROM ext_permissions WHERE code LIKE 'api:%';
