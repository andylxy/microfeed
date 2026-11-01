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
import {readSnapshotGate} from "@/server/rbac/snapshot";
import {adminLoginDeniedResponse} from "@/server/auth/admin-signin";
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

  // 封禁标记随验票同一趟 LEFT JOIN 取回（方案 4.4），不再单独查一次 `auth_user`。
  const verified = await verifyLoginCredentialToken(env.FEED_DB, token);
  if (!verified || verified.banned) {
    if (throttleKey) await recordLoginFailure(env.FEED_DB, throttleKey);
    return publicLocalizedError(request, "errors.loginCredential.invalid", 401);
  }

  // 角色可能挡住后台入口（`ext_roles.allow_admin_login`）。这一判放在建会话
  // 之前：给一个进不了后台的账号发会话 cookie，只会让它每次都被 403 弹回来。
  // 不记失败次数——凭证本身是对的，记了会把正确的凭证也一起限流。
  // 拒绝响应与另一条登录通道（admin-signin.ts 的后处理门）共用一份。
  //
  // 判据取自权限快照（ADR-0053），与 middleware 的每请求判断同一个来源。两处
  // 用不同判据会出现「凭证签发成功、每次请求 403」，浏览器在登录页与后台之间
  // 反复跳转。
  const gate = await readSnapshotGate(env.FEED_DB, verified.userId);
  if (gate === null || !gate.adminLoginAllowed) {
    return adminLoginDeniedResponse(request);
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
