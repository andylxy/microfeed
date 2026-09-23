-- 0038_ext_api_access_log_credential.sql
--
-- Widens the API audit trail to cover the sessionless login-credential bearer
-- path (`Authorization: Bearer mflc_…`), which has no `api_keys` row to
-- attribute a call to. Before this migration only the signed-call path wrote
-- `ext_api_access_log` rows, so credential-authenticated calls — allowed or
-- denied — left no audit trail.
--
-- The original table declared `api_key_id TEXT NOT NULL`; a credential call has
-- no key, so that column becomes nullable and `credential_id` is added beside
-- it: exactly one of the two identifies the caller.
--
-- SQLite cannot relax a NOT NULL constraint in place, hence the rebuild-and-copy
-- below (create new table, copy rows, drop, rename). Existing rows keep their
-- `api_key_id` and get a NULL `credential_id`.

CREATE TABLE ext_api_access_log_v2 (
  id              TEXT NOT NULL PRIMARY KEY,
  api_key_id      TEXT,
  credential_id   TEXT,
  user_id         TEXT NOT NULL,
  method          TEXT NOT NULL,
  path            TEXT NOT NULL,
  permission_code TEXT NOT NULL,
  granted         INTEGER NOT NULL,
  status          INTEGER NOT NULL,
  created_at_ms   INTEGER NOT NULL
);

INSERT INTO ext_api_access_log_v2
  (id, api_key_id, credential_id, user_id, method, path, permission_code,
   granted, status, created_at_ms)
SELECT id, api_key_id, NULL, user_id, method, path, permission_code,
       granted, status, created_at_ms
FROM ext_api_access_log;

DROP TABLE ext_api_access_log;

ALTER TABLE ext_api_access_log_v2 RENAME TO ext_api_access_log;

CREATE INDEX IF NOT EXISTS ext_api_access_log_user
  ON ext_api_access_log(user_id);
CREATE INDEX IF NOT EXISTS ext_api_access_log_key
  ON ext_api_access_log(api_key_id);
CREATE INDEX IF NOT EXISTS ext_api_access_log_credential
  ON ext_api_access_log(credential_id);
