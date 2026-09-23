/**
 * Fixed-window brute-force throttle for the credential sign-in endpoint.
 *
 * A login credential is a bearer secret; the endpoint that exchanges it for a
 * session is therefore the highest-value target in this feature and is limited
 * independently of better-auth's own `/sign-in/*` rules (which do not see our
 * Astro route at all).
 *
 * Rows self-prune: once `reset_at_ms` has passed the window restarts, so the
 * table stays bounded without a cleanup job.
 */

export const LOGIN_THROTTLE_MAX_ATTEMPTS = 10;
export const LOGIN_THROTTLE_WINDOW_MS = 60_000;

/** Best-effort client address; Cloudflare sets `cf-connecting-ip` in production. */
export function clientAddress(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
}

/** `false` once the caller has exhausted its attempts for the current window. */
export async function loginThrottleAllows(
  database: D1Database,
  key: string,
): Promise<boolean> {
  const row = await database.prepare(
    "SELECT count, reset_at_ms FROM ext_login_credential_attempts " +
      "WHERE key = ? LIMIT 1",
  ).bind(key).first<{count: number; reset_at_ms: number}>();
  if (!row || Number(row.reset_at_ms) <= Date.now()) return true;
  return Number(row.count) < LOGIN_THROTTLE_MAX_ATTEMPTS;
}

/** Increment the window counter, restarting it when the previous one lapsed. */
export async function recordLoginFailure(
  database: D1Database,
  key: string,
): Promise<void> {
  const now = Date.now();
  const nextReset = now + LOGIN_THROTTLE_WINDOW_MS;
  await database.prepare(
    "INSERT INTO ext_login_credential_attempts (key, count, reset_at_ms) " +
      "VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET " +
      "count = CASE WHEN ext_login_credential_attempts.reset_at_ms <= ? " +
      "THEN 1 ELSE ext_login_credential_attempts.count + 1 END, " +
      "reset_at_ms = CASE WHEN ext_login_credential_attempts.reset_at_ms <= ? " +
      "THEN ? ELSE ext_login_credential_attempts.reset_at_ms END",
  ).bind(key, nextReset, now, now, nextReset).run();
}

/** Clear the counter after a successful sign-in. */
export async function clearLoginThrottle(
  database: D1Database,
  key: string,
): Promise<void> {
  await database.prepare(
    "DELETE FROM ext_login_credential_attempts WHERE key = ?",
  ).bind(key).run();
}
