-- 0053_backfill_admin_super_admin.sql
--
-- RBAC is the only authority for the dashboard now: the guard's legacy
-- `auth_user.role = 'admin'` bypass has been removed.
--
-- Two steps, in this order:
--
--   1. Give `super_admin` to every administrator that holds **no RBAC role at
--      all**. Those accounts got everything from the bypass, so the grant
--      preserves their access. An administrator that already holds an explicit
--      RBAC role keeps exactly that role — the bypass no longer overrides it,
--      which is the point of removing it.
--
--   2. Mirror the RBAC `super_admin` role onto `auth_user.role`. Better Auth's
--      admin plugin gates its own endpoints on that field (see
--      `BETTER_AUTH_ADMIN_ROLE` in src/shared/Rbac.ts), so leaving a stray
--      `'admin'` behind would leave a second way to authorize. After this the
--      field is derived: `'admin'` iff the account holds the RBAC role.
--
-- Idempotent: re-applying produces the same rows.

INSERT OR IGNORE INTO ext_user_roles (user_id, role_id)
  SELECT u.id, 'r_super_admin' FROM auth_user u
  WHERE u.role = 'admin'
    AND NOT EXISTS (SELECT 1 FROM ext_user_roles r WHERE r.user_id = u.id);

UPDATE auth_user
  SET role = 'admin'
  WHERE id IN (
    SELECT user_id FROM ext_user_roles WHERE role_id = 'r_super_admin'
  );

UPDATE auth_user
  SET role = 'user'
  WHERE role = 'admin'
    AND id NOT IN (
      SELECT user_id FROM ext_user_roles WHERE role_id = 'r_super_admin'
    );
