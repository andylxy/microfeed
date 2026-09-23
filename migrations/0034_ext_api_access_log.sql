-- 0034_ext_api_access_log.sql
--
-- Audit trail that ties every signed API submission to both the API key and the
-- owning user. Written (best-effort, non-blocking) on every signed request,
-- whether allowed or denied, so "who called what" is always answerable.

CREATE TABLE IF NOT EXISTS ext_api_access_log (
  id             TEXT NOT NULL PRIMARY KEY,
  api_key_id     TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  method         TEXT NOT NULL,
  path           TEXT NOT NULL,
  permission_code TEXT NOT NULL,
  granted        INTEGER NOT NULL,
  status         INTEGER NOT NULL,
  created_at_ms  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ext_api_access_log_user
  ON ext_api_access_log(user_id);
CREATE INDEX IF NOT EXISTS ext_api_access_log_key
  ON ext_api_access_log(api_key_id);
