/**
 * Login methods config write (`POST /admin/ajax/login-methods/save`).
 *
 * Body: `{patch: {<toggleKey>: boolean}}` — read-merge-write via
 * `saveLoginMethodsConfig` (ADR-0050 D3): the server fills `updatedAtMs` /
 * `updatedBy`, upserts the settings row and clears the app-side cache entry.
 * Guarded by `system:app-login-methods:manage`. Non-boolean patch values are
 * a clean 400 (discriminated result, no throw). All switches may be turned
 * off (ADR-0050 D5).
 */
import {cache, env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import FeedDb from "@/server/feed/FeedDb";
import {saveLoginMethodsConfig} from "@/server/app/login/config";
import {jsonResponse, localizedError} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

export const POST: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.SYSTEM_APP_LOGIN_METHODS_MANAGE,
    request,
    env.FEED_DB,
  );
  const userId = locals.authUser?.id;
  if (guard) return guard;
  if (!userId) {
    return localizedError(request, "errors.account.notFound", 404);
  }
  const body = await request.json().catch(() => null) as
    | {patch?: unknown}
    | null;
  const result = await saveLoginMethodsConfig(
    new FeedDb(env, request, cache),
    (body?.patch ?? {}) as Record<string, unknown>,
    userId,
  );
  if (!result.ok) {
    return localizedError(request, "errors.appLoginMethods.invalidConfig", 400);
  }
  return jsonResponse({ok: true});
};
