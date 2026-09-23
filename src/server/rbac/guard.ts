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
 *   6. code in permission set                  -> ALLOW
 *   7. otherwise                               -> 403
 *
 * Steps 2-4 come before 5-6 on purpose: a super_admin whose device was revoked
 * must be kicked out, and one who must change their password must be stopped,
 * exactly like any other account.
 *
 * There is deliberately no legacy `auth_user.role = 'admin'` bypass any more:
 * RBAC is the only authority. Every administrator that used to depend on that
 * bypass holds the `super_admin` role instead — migration 0031 backfilled the
 * historical ones, 0053 closes the remaining gap, and `password-setup` grants
 * it at creation. `auth_user.role` stays a Better Auth field that authorises
 * nothing.
 *
 * Status code spectrum (DESIGN.md §7): 401 unauthorized, 403 forbidden,
 * 400 replay, 428 must-change-password, 426 app-version-too-low.
 */

import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {RBAC_WILDCARD} from "./resolve";
import {checkReplay} from "./replay";
import {type PermissionCode} from "@/shared/Constants";

export interface RbacLocals {
  /**
   * The signed-in account. Only `id` is read here: `auth_user.role` used to feed
   * a legacy bypass and now authorises nothing in this module — it only gates
   * Better Auth's own admin plugin (see `BETTER_AUTH_ADMIN_ROLE`).
   */
  authUser?: {id?: string} | null;
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

/**
 * The account-level half of the decision chain (ADR-001 D-010 steps 1-4):
 * signed in, not banned, device not revoked, password not pending a change.
 *
 * Extracted so an endpoint that only needs "is this a live account?" — e.g. the
 * self-service login-credential panel, which grants no permission of its own —
 * does not have to name a permission the caller may not hold.
 */
export function requireAccountAccess(
  locals: RbacLocals,
  options: {exemptFromMustChange?: boolean} = {},
): Response | null {
  const user = locals.authUser;
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

  return null;
}

/**
 * The permission half of the decision chain, in one place: a full-access grant
 * (`*`) or a hit on `code` resolves to *allowed*. Both {@link requirePermission}
 * (which layers the account gates on top) and {@link rbacAllows} (the menu's
 * yes/no view) call this, so the rule can never drift between "what the menu
 * shows" and "what an endpoint allows" — the exact failure the menu/page split
 * was built to avoid.
 *
 * Callers must have already established a live user: {@link requirePermission}
 * via {@link requireAccountAccess}, and {@link rbacAllows} via its own
 * no-session short-circuit.
 */
export function hasPermission(locals: RbacLocals, code: string): boolean {
  const permissions = locals.rbacPermissions;
  if (permissions?.has(RBAC_WILDCARD)) {
    return true;
  }

  return Boolean(permissions?.has(code));
}

export function requirePermission(
  locals: RbacLocals,
  code: PermissionCode,
  options: {exemptFromMustChange?: boolean} = {},
): Response | null {
  const account = requireAccountAccess(locals, options);
  if (account) {
    return account;
  }

  if (hasPermission(locals, code)) {
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
/**
 * Visibility half of the same decision, for places that need a yes/no rather
 * than a `Response` — the admin menu is the one that matters: it must agree with
 * {@link requirePermission} or an account ends up with a link it cannot open
 * (or no link to a page it may open).
 *
 * `code === null` models a menu that binds no permission at all (a public entry
 * such as the dashboard home) and is therefore visible to anyone signed in.
 * Unlike {@link requirePermission} this deliberately skips the account gates
 * (banned / device revoked / must-change-password): those are enforced by the
 * request path, and a menu is only ever rendered for a live session.
 *
 * @param code The permission code to test, or `null` for a public entry.
 */
export function rbacAllows(locals: RbacLocals, code: string | null): boolean {
  const user = locals.authUser as
    | {id?: string; role?: string | null}
    | null
    | undefined;
  if (!user || !user.id) {
    return false;
  }

  // A menu bound to no permission is public (the dashboard home) and shows for
  // any signed-in account; every other entry defers to the shared decision.
  if (code === null) return true;

  return hasPermission(locals, code);
}

/**
 * Compose the RBAC gate around an endpoint handler, mirroring
 * `withWebhookGuard`. Route files that merely re-export a handler from a server
 * module wrap it here instead of opening the handler up to add the check.
 */
export function withRbacGuard(handler: APIRoute, code: PermissionCode): APIRoute {
  return async (context) => {
    const denied = await requireRbac(
      context.locals,
      code,
      context.request,
      env.FEED_DB,
    );
    if (denied) return denied;
    return handler(context);
  };
}

export async function requireRbac(
  locals: RbacLocals,
  code: PermissionCode,
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

/**
 * Gate for an endpoint that needs a live account but no specific permission:
 * version -> replay -> account. Mirrors {@link requireRbac} so the anti-replay
 * and app-version ordering stay identical; only the permission step is dropped.
 * Used by the self-service login-credential endpoints, where the caller is
 * acting on their own account and therefore needs no grant.
 */
export async function requireAuthenticatedRbac(
  locals: RbacLocals,
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

  return requireAccountAccess(locals, options);
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
