/**
 * RBAC enforcement helpers for microfeed admin endpoints.
 *
 * Decision order follows ADR-001 D-010 literally, so the account-level gates
 * cannot be bypassed by holding a full-access grant:
 *   1. no authenticated user                   -> 401
 *   2. auth_user.banned = 1                    -> 401
 *   3. device revoked                          -> 401
 *   4. must_change_password & not exempt       -> 428
 *   5. wildcard permission set (`*`)           -> ALLOW
 *   6. legacy Better Auth admin (role='admin') -> ALLOW
 *      (upgrade safety: never lock out existing admins, or admins created later
 *       via the Better Auth admin plugin — fine-grained RBAC applies to non-admin
 *       accounts). Migration 0031 also backfills existing admins explicitly.)
 *   7. code in permission set                  -> ALLOW
 *   8. otherwise                               -> 403
 *
 * Steps 2-4 come before 5-6 on purpose: a super_admin whose device was revoked
 * must be kicked out, and one who must change their password must be stopped,
 * exactly like any other account.
 *
 * Status code spectrum (DESIGN.md §7): 401 unauthorized, 403 forbidden,
 * 400 replay, 428 must-change-password, 426 app-version-too-low.
 */

import {RBAC_WILDCARD} from "./resolve";
import {checkReplay} from "./replay";

export interface RbacLocals {
  authUser?: {id?: string; role?: string | null} | null;
  rbacPermissions?: Set<string> | null;
  rbacMustChangePassword?: boolean;
  rbacDeviceRevoked?: boolean;
  rbacBanned?: boolean;
}

const MIN_SUPPORTED_APP_VERSION = "1.0.0";

/** App-Version < minimum -> 426. Web admin sends no header, so it is skipped. */
export function requireAppVersion(request: Request): Response | null {
  const header = request.headers.get("app-version");
  if (!header) return null;
  if (compareVersion(header, MIN_SUPPORTED_APP_VERSION) < 0) {
    return new Response("App version too low", {status: 426});
  }
  return null;
}

function compareVersion(a: string, b: string): number {
  const pa = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i++) {
    const delta = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function requirePermission(
  locals: RbacLocals,
  code: string,
  options: {exemptFromMustChange?: boolean} = {},
): Response | null {
  const user = locals.authUser as
    | {id?: string; role?: string | null}
    | null
    | undefined;
  if (!user || !user.id) {
    return new Response("Unauthorized", {status: 401});
  }

  if (locals.rbacBanned) {
    return new Response("Unauthorized", {status: 401});
  }

  if (locals.rbacDeviceRevoked) {
    return new Response("Unauthorized", {status: 401});
  }

  if (locals.rbacMustChangePassword && !options.exemptFromMustChange) {
    return new Response("Password change required", {status: 428});
  }

  const permissions = locals.rbacPermissions;
  if (permissions && permissions.has(RBAC_WILDCARD)) {
    return null;
  }

  if (user.role === "admin") {
    // Legacy Better Auth administrator: preserve pre-RBAC full access.
    return null;
  }

  if (permissions && permissions.has(code)) {
    return null;
  }

  return new Response("Forbidden", {status: 403});
}

/**
 * Combined gate for a protected endpoint: version -> replay -> permission.
 * ADR-001 D-011 puts the anti-replay check *before* the permission guard, so a
 * replayed request is rejected on its own merits rather than reporting whatever
 * the permission decision would have been.
 * Returns a `Response` to short-circuit, or `null` when the request is allowed.
 */
export async function requireRbac(
  locals: RbacLocals,
  code: string,
  request: Request,
  db: D1Database,
  options: {exemptFromMustChange?: boolean; skipReplay?: boolean} = {},
): Promise<Response | null> {
  const version = requireAppVersion(request);
  if (version) return version;

  if (!options.skipReplay) {
    const replay = await checkReplay(db, request);
    if (replay) return replay;
  }

  const permission = requirePermission(locals, code, options);
  if (permission) return permission;

  return null;
}

/** Clear the forced-password-change flag after a successful change. */
export async function clearMustChangePassword(
  db: D1Database,
  userId: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE ext_user_security SET must_change_password = 0 WHERE user_id = ?",
    )
    .bind(userId)
    .run();
}
