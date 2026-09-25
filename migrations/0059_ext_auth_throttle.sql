-- A6: per-IP throttle for the username sign-in and change-password endpoints.
-- better-auth's customRules only cover /sign-in/email (5/60s); the username
-- variant fell through to the lax 100/60s default, leaving a brute-force gap.
-- The throttle is enforced at the single /api/auth throat
-- (src/pages/api/auth/[...all].ts), which keeps the rule local and out of the
-- red-line better-auth.ts file so upstream merges stay clean.
CREATE TABLE IF NOT EXISTS ext_auth_throttle (
  key          TEXT PRIMARY KEY,
  attempts     INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);
