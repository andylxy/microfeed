/**
 * Best-effort client address for the auth throttles.
 *
 * Cloudflare sets `cf-connecting-ip` in production. Behind another front, the
 * first hop of `x-forwarded-for` is the closest equivalent. Returns `null` when
 * neither is present, and callers then **skip the IP dimension** of throttling
 * rather than sharing one global bucket (B13): a global bucket would let a
 * single noisy client lock out everyone.
 *
 * Kept in its own module because both throttles need exactly this resolution —
 * `login-throttle.ts` (credential sign-in) and `auth-endpoint-throttle.ts`
 * (`/api/auth` throat) — and neither should own the other's copy.
 */
export function clientAddress(request: Request): string | null {
  return request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null;
}
