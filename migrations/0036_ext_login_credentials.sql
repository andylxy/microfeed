-- 0036_ext_login_credentials.sql
--
-- Login credentials: opaque `mflc_…` tokens that let a user authenticate (either
-- by establishing a session, or as a bearer on the public API) without a
-- password or passkey. Additive `ext_` namespace; the better-auth core tables
-- (`auth_user`/`auth_session`) are not touched.
--
-- The plaintext token is stored in `secret` on purpose: the product requirement
-- is to be able to re-display and copy it at any time, so a one-way hash alone
-- would not do. `secret_hash` is the constant-time lookup key used during
-- verification, so comparisons never depend on the plaintext column.
--
-- Deletion of the owning user is handled in application code rather than via
-- ON DELETE CASCADE, to stay compatible with D1's foreign-key pragma (same
-- rationale as ext_api_key_owners).

CREATE TABLE IF NOT EXISTS ext_login_credentials (
  id              TEXT NOT NULL PRIMARY KEY,
  user_id         TEXT NOT NULL,
  name            TEXT NOT NULL,
  secret          TEXT NOT NULL,
  secret_hash     TEXT NOT NULL,
  created_at_ms   INTEGER NOT NULL,
  expires_at_ms   INTEGER,
  revoked         INTEGER NOT NULL DEFAULT 0,
  last_used_at_ms INTEGER,
  FOREIGN KEY (user_id) REFERENCES auth_user(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ext_login_credentials_secret_hash
  ON ext_login_credentials(secret_hash);

CREATE INDEX IF NOT EXISTS ext_login_credentials_user
  ON ext_login_credentials(user_id);
