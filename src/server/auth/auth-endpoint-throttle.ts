/**
 * A6: stricter per-IP throttle for the username sign-in and change-password
 * endpoints.
 *
 * better-auth's `rateLimit.customRules` only covers `/sign-in/email` (5/60s);
 * the username variant and `change-password` fell through to the lax 100/60s
 * default, leaving a brute-force gap. Rather than edit the red-line
 * `better-auth.ts` (which would widen the upstream merge conflict), we intercept
 * at the single `/api/auth` throat — `src/pages/api/auth/[...all].ts` — one call
 * placed immediately before `auth.handler(request)`.
 *
 * The rule allows 5 attempts per 60s window per client address. Address
 * resolution is shared with the credential throttle (`client-address.ts`):
 * `cf-connecting-ip`, else the first `x-forwarded-for` hop, else **skip the IP
 * dimension entirely** (B13's decision, applied here for consistency — one
 * global bucket per endpoint would let a single client lock out every other
 * caller, which is a worse failure than an unthrottled request on a deployment
 * that never reports an address).
 *
 * The window counter itself stays separate from `login-throttle.ts` on purpose:
 * this one counts *pre-checked attempts in seconds* and answers 429 here, while
 * the credential throttle counts *failures in ms* and is cleared on success.
 * They share the address resolution and the shape, not the semantics.
 */

import {clientAddress} from "@/server/auth/client-address";

const AUTH_ENDPOINT_THROTTLE_MAX = 5;
const AUTH_ENDPOINT_THROTTLE_WINDOW_SECONDS = 60;

const THROTTLED_AUTH_PATHS = new Set([
  "/api/auth/sign-in/username",
  "/api/auth/change-password",
]);

export async function enforceAuthEndpointThrottle(
  database: D1Database,
  request: Request,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  if (!THROTTLED_AUTH_PATHS.has(pathname)) return null;

  const ip = clientAddress(request);
  if (!ip) return null;

  const key = `auth:${ip}:${pathname}`;
  const nowSeconds = Math.floor(Date.now() / 1000);

  const row = await database.prepare(
    "SELECT attempts, window_start FROM ext_auth_throttle WHERE key = ?",
  ).bind(key).first<{attempts: number; window_start: number}>();

  // Fresh key, or the window has rolled over: start a new window and allow.
  if (!row || nowSeconds - row.window_start >= AUTH_ENDPOINT_THROTTLE_WINDOW_SECONDS) {
    await database.prepare(
      "INSERT INTO ext_auth_throttle (key, attempts, window_start) VALUES (?, 1, ?) " +
        "ON CONFLICT(key) DO UPDATE SET attempts = 1, window_start = excluded.window_start",
    ).bind(key, nowSeconds).run();
    return null;
  }

  if (row.attempts >= AUTH_ENDPOINT_THROTTLE_MAX) {
    const retryAfter = AUTH_ENDPOINT_THROTTLE_WINDOW_SECONDS -
      (nowSeconds - row.window_start);
    return new Response("Too Many Requests", {
      headers: {
        "cache-control": "no-store",
        "retry-after": String(Math.max(1, retryAfter)),
      },
      status: 429,
    });
  }

  await database.prepare(
    "UPDATE ext_auth_throttle SET attempts = attempts + 1 WHERE key = ?",
  ).bind(key).run();
  return null;
}
