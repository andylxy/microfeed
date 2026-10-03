/**
 * App version board write (`POST /admin/ajax/app-versions/save`).
 *
 * Body: `{config?: {...}, rules?: [...]}` — either half may be omitted, so the
 * page can save the form and the rollout table independently. Guarded by
 * `system:app-version:manage`. Both writers validate and return a discriminated
 * result instead of throwing, so an invalid payload is a clean 400.
 */
import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {
  saveAppVersionConfig,
  saveRolloutRules,
} from "@/server/app-version/config";
import {jsonResponse, localizedError} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import type {AppVersionSavePayload} from "@/shared/AppDeviceVersion";
import {PERMISSION_CODES} from "@/shared/Constants";

export const POST: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.SYSTEM_APP_VERSION_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const body = await request.json().catch(() => null) as
    | AppVersionSavePayload
    | null;
  if (body?.config !== undefined) {
    const result = await saveAppVersionConfig(env.FEED_DB, body.config);
    if (!result.ok) {
      return localizedError(request, "errors.appVersions.invalidConfig", 400);
    }
  }
  if (body?.rules !== undefined) {
    const result = await saveRolloutRules(env.FEED_DB, body.rules);
    if (!result.ok) {
      return localizedError(request, "errors.appVersions.invalidRule", 400);
    }
  }
  return jsonResponse({ok: true});
};
