-- RBAC extension tables (fine-grained role -> permission).
--
-- Everything here lives in the `ext_` namespace and is purely additive so it
-- stays upgrade-safe: applying this migration on top of an upstream microfeed
-- schema adds new tables without touching any existing ones. Upgrade rebase
-- only needs to keep this file's number (0028) after the latest upstream
-- migration. Existing Better Auth tables (`auth_user` / `auth_session`) and the
-- `createMicrofeedAuth` factory are NOT modified.

CREATE TABLE IF NOT EXISTS ext_roles (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ext_roles_code ON ext_roles (code);

CREATE TABLE IF NOT EXISTS ext_permissions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ext_permissions_code ON ext_permissions (code);

CREATE TABLE IF NOT EXISTS ext_user_roles (
  user_id TEXT NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES ext_roles (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX IF NOT EXISTS ext_user_roles_user_id ON ext_user_roles (user_id);
CREATE INDEX IF NOT EXISTS ext_user_roles_role_id ON ext_user_roles (role_id);

CREATE TABLE IF NOT EXISTS ext_role_permissions (
  role_id TEXT NOT NULL REFERENCES ext_roles (id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES ext_permissions (id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);
CREATE INDEX IF NOT EXISTS ext_role_permissions_role_id ON ext_role_permissions (role_id);
CREATE INDEX IF NOT EXISTS ext_role_permissions_permission_id ON ext_role_permissions (permission_id);

CREATE TABLE IF NOT EXISTS ext_user_security (
  user_id TEXT PRIMARY KEY REFERENCES auth_user (id) ON DELETE CASCADE,
  must_change_password BOOLEAN NOT NULL DEFAULT 0
);
