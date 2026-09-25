/**
 * Credential sign-in: exchange a login credential (`mflc_…`) for a real
 * better-auth session.
 *
 * Reached unauthenticated, so the middleware exempts this one admin AXI path
 * the same way it exempts the password-setup flow. Two guards therefore live
 * here rather than in the shared admin branch:
 *  - a same-origin check for body-based posts (CSRF), skipped when the token
 *    arrives in the `Authorization` header, which a cross-site form cannot set;
 *  - a fixed-window throttle, because the credential is a bearer secret.
 */

import {env} from "cloudflare:workers";

import {createLoginSessionCookies} from "@/server/auth/login-session";
import {
  markLoginCredentialUsed,
  verifyLoginCredentialToken,
} from "@/server/auth/login-credentials";
import {clientAddress} from "@/server/auth/client-address";
import {
  clearLoginThrottle,
  loginThrottleAllows,
  recordLoginFailure,
} from "@/server/auth/login-throttle";
import {jsonResponse, publicLocalizedError} from "@/server/http";
import {accountIsBlocked} from "@/server/rbac/resolve";
import {adminUrl} from "@/shared/AdminPath";

export function isAdminCredentialLoginPath(
  pathname: string,
  adminPath: string,
): boolean {
  return pathname === adminUrl("ajax/auth/credential-login", adminPath);
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization")?.trim();
  if (!authorization) return undefined;
  const match = /^Bearer\s+(.+)$/iu.exec(authorization);
  return match?.[1]?.trim() || undefined;
}

/** The `mflc_…` credential presented in `Authorization`, if any. */
export function providedLoginCredentialBearer(
  request: Request,
): string | undefined {
  const token = bearerToken(request);
  return token?.startsWith("mflc_") ? token : undefined;
}

export async function handleCredentialLogin(
  request: Request,
): Promise<Response> {
  if (request.method !== "POST") {
    return publicLocalizedError(request, "errors.general.notFound", 404);
  }

  const headerToken = providedLoginCredentialBearer(request);
  if (
    !headerToken &&
    request.headers.get("origin") !== new URL(request.url).origin
  ) {
    return publicLocalizedError(request, "errors.loginCredential.crossOrigin", 403);
  }

  const body = await request.json().catch(() => null) as
    | {token?: unknown}
    | null;
  const token = (typeof body?.token === "string" ? body.token.trim() : "") ||
    headerToken ||
    "";
  if (!token) {
    return publicLocalizedError(request, "errors.loginCredential.tokenRequired", 400);
  }

  // B13: with no client address, skip the IP dimension of throttling instead of
  // sharing a global "unknown" bucket that would lock out every addressless caller.
  const ip = clientAddress(request);
  const throttleKey = ip ? `${ip}:/ajax/auth/credential-login` : null;
  if (throttleKey && !await loginThrottleAllows(env.FEED_DB, throttleKey)) {
    return publicLocalizedError(request, "errors.loginCredential.tooManyAttempts", 429);
  }

  const verified = await verifyLoginCredentialToken(env.FEED_DB, token);
  const blocked = verified
    ? await accountIsBlocked(env.FEED_DB, verified.userId)
    : false;
  if (!verified || blocked) {
    if (throttleKey) await recordLoginFailure(env.FEED_DB, throttleKey);
    return publicLocalizedError(request, "errors.loginCredential.invalid", 401);
  }

  let cookies: string[];
  try {
    cookies = await createLoginSessionCookies(env, request, verified.userId);
  } catch (error) {
    // The client gets one generic message on purpose (a failed session write is
    // not something a caller can act on), so the cause has to survive in the log
    // or it is lost entirely.
    console.error("credential-login: session creation failed", error);
    return publicLocalizedError(request, "errors.loginCredential.unavailable", 500);
  }
  if (throttleKey) await clearLoginThrottle(env.FEED_DB, throttleKey);
  await markLoginCredentialUsed(env.FEED_DB, verified.credentialId);

  const headers = new Headers();
  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }
  return jsonResponse({ok: true}, {headers});
}
