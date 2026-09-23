-- 0037_ext_login_credential_attempts.sql
--
-- Fixed-window brute-force throttle for the credential sign-in endpoint. A login
-- credential is a bearer secret, so the endpoint that exchanges it for a session
-- is the highest-value target in this feature and must be rate limited
-- independently of better-auth's own `/sign-in/*` rules.
--
-- One row per throttle key (client IP + scope). The counter is reset once
-- `reset_at_ms` passes, so the table stays tiny and self-pruning on read.

CREATE TABLE IF NOT EXISTS ext_login_credential_attempts (
  key         TEXT NOT NULL PRIMARY KEY,
  count       INTEGER NOT NULL,
  reset_at_ms INTEGER NOT NULL
);
