/**
 * About page content write (`POST /admin/ajax/app-about/save`).
 *
 * Body: `{entries: [{name, text}]}` — **整表同步**（见 `saveAboutInfo`）：
 * upsert 提交行、删除未提交行。Guarded by `system:app-about:manage`. The writer
 * validates and returns a discriminated result instead of throwing, so an
 * invalid payload is a clean 400.
 */
import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {saveAboutInfo} from "@/server/app/about/config";
import {jsonResponse, localizedError} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

export const POST: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.SYSTEM_APP_ABOUT_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const body = await request.json().catch(() => null) as
    | {entries?: unknown}
    | null;
  const result = await saveAboutInfo(env.FEED_DB, body?.entries);
  if (!result.ok) {
    return localizedError(request, "errors.appAbout.invalidEntry", 400);
  }
  return jsonResponse({ok: true});
};
