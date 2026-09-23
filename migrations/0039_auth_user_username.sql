-- 0039_auth_user_username.sql
--
-- Lets an account sign in with a username as well as an address, by adding the
-- two columns that better-auth's official `username` plugin declares on the user
-- model (`username`, unique and lowercased; `displayUsername`, the original
-- casing). Registering the plugin without these columns makes better-auth fail
-- at boot, so this migration has to ship with it.
--
-- Additive only: existing rows keep NULL in both columns, which the UNIQUE index
-- tolerates (SQLite allows repeated NULLs), so every current account keeps
-- signing in by address exactly as before.
--
-- The address column stays NOT NULL: better-auth requires it on every user, so
-- an account created from a username alone gets a placeholder address under
-- `users.microfeed.local` (see `adminUsernameEmail` in AdminCredentials.ts).
-- Such an address is unreachable by design, so those accounts cannot receive
-- password-reset mail.

ALTER TABLE auth_user ADD COLUMN username TEXT;
ALTER TABLE auth_user ADD COLUMN displayUsername TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS auth_user_username
  ON auth_user(username);
