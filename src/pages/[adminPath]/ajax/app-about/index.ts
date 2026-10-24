/**
 * About page content read (`GET /admin/ajax/app-about/`).
 *
 * Returns every `ext_app_about_info` row as `{name, text}` entries, guarded by
 * `system:app-about:read`. Writes live in `save.ts` (`:manage`).
 */
import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {readAboutInfo} from "@/server/app/about/config";
import {jsonResponse} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

export const GET: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.SYSTEM_APP_ABOUT_READ,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  return jsonResponse(
    {entries: await readAboutInfo(env.FEED_DB)},
    {headers: {"cache-control": "private, no-store"}},
  );
};
