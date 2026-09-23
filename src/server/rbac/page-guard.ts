/**
 * Page-level permission gate for the dashboard.
 *
 * Every menu page must guard itself with **the same permission code its menu row
 * binds** (`ext_menu.permission_code`). If the two drift, an account gets either
 * a link it cannot open (menu visible, page 403) or a page it can reach with no
 * way to navigate to it. See `ADR-002-admin-menu-as-data.md`.
 *
 * The menu being data does NOT make it access control: hiding an entry is
 * presentation, this is enforcement.
 */

import {env} from "cloudflare:workers";

import {requirePermission, type RbacLocals} from "@/server/rbac/guard";
import {type PermissionCode} from "@/shared/Constants";
import {adminUrl, normalizeAdminPath} from "@/shared/AdminPath";
import {type AdminLanguage} from "@/shared/AdminLanguage";
import {translate} from "@/shared/i18n";

/**
 * Returns a `Response` to short-circuit the page, or `null` when the account
 * holds `code`. Account-level gates (not signed in, banned, device revoked,
 * must-change-password) come from {@link requirePermission}, so pages and
 * endpoints refuse for exactly the same reasons.
 */
export function requirePagePermission(
  locals: RbacLocals,
  code: PermissionCode,
  language: AdminLanguage,
): Response | null {
  const denied = requirePermission(locals, code);
  if (!denied) return null;
  // A missing permission sends the visitor to the forbidden page, which renders
  // inside the dashboard shell and carries a way back. Anything else (not signed
  // in, banned, device revoked, password change pending) keeps its own status —
  // those are not "you lack access to this page".
  if (denied.status !== 403) return denied;

  const adminPath = normalizeAdminPath(env.MICROFEED_ADMIN_PATH);
  return new Response(translate("errors.rbac.forbidden", language), {
    headers: {location: adminUrl("forbidden", adminPath)},
    status: 302,
  });
}
