-- 0042_clear_must_change_password.sql
--
-- Local policy: this deployment does NOT force a password change on first sign
-- in. `createAdminRbacUser` no longer writes the flag (see rbac-handlers.ts),
-- and this one-time sweep clears it from any account provisioned while the old
-- behaviour was in place — otherwise those accounts keep hitting the guard's
-- 428 branch and cannot open a single dashboard page.
--
-- The 428 machinery itself is left in place but dormant: nothing writes
-- `must_change_password` any more, yet the guard branch in
-- `src/server/rbac/guard.ts` and `clearMustChangePassword` stay for a possible
-- future producer (e.g. an admin-triggered forced reset).
--
-- Idempotent: `UPDATE ... SET 0` is safe to re-apply.

UPDATE ext_user_security
  SET must_change_password = 0
  WHERE must_change_password <> 0;
