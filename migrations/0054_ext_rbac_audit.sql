-- 0054_ext_rbac_audit.sql
--
-- Role and permission changes were invisible: `rbac-handlers.ts` mutated
-- `ext_roles` / `ext_role_permissions` / `ext_user_roles` without leaving any
-- trace, so "who gave this account that role?" had no answer. This table is the
-- answer.
--
-- Append-only by convention: nothing in the codebase updates or deletes a row.
-- `actor_user_id` is deliberately not a foreign key — an audit row must survive
-- the account it names, exactly like `ext_api_access_log`.
--
-- Purely local (`ext_` namespace, new table), so it adds nothing to the upstream
-- merge surface.
--
-- Idempotent (`IF NOT EXISTS`) so re-applying migrations is safe.

CREATE TABLE IF NOT EXISTS ext_rbac_audit (
  id            TEXT PRIMARY KEY,
  actor_user_id TEXT,
  actor_label   TEXT,
  action        TEXT NOT NULL,
  target        TEXT,
  detail        TEXT,
  before_detail TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_ext_rbac_audit_created
  ON ext_rbac_audit(created_at_ms);
