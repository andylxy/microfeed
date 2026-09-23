-- 0032_ext_api_key_owners.sql
--
-- Links each API credential to the user who owns it. This is the missing link
-- the signed-call capability needs: a request is authenticated by verifying the
-- signature against the key, and the key resolves to a *user* here, so every
-- submission can be attributed. Additive `ext_` namespace; does not touch the
-- better-auth core tables (`auth_user`/`auth_session`).
--
-- Deletion of the owner row is handled in application code (api-keys.ts) rather
-- than via ON DELETE CASCADE, to stay compatible with D1's foreign-key pragma.

CREATE TABLE IF NOT EXISTS ext_api_key_owners (
  api_key_id    TEXT NOT NULL PRIMARY KEY,
  user_id       TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id),
  FOREIGN KEY (user_id) REFERENCES auth_user(id)
);

CREATE INDEX IF NOT EXISTS ext_api_key_owners_user
  ON ext_api_key_owners(user_id);
