-- 0033_api_keys_secret_hash.sql
--
-- Adds storage for the API *secret* used to sign requests. The plaintext secret
-- is returned to the client exactly once (on issue / rotation); only its hash is
-- persisted, matching the XiHan BasicApp "server stores only a hash" model.
-- Existing rows (admin-issued bearer keys created before this migration) have a
-- NULL secret_hash and therefore cannot sign — they remain bearer-only.

ALTER TABLE api_keys ADD COLUMN secret_hash TEXT;
