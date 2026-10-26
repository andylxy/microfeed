/**
 * Cache control read (`GET /admin/ajax/cache/`).
 *
 * Returns the current `app_cache_control` row plus the constants the page renders
 * (TTL ranges, bucket list, purge limits come from `@/shared/AppCacheControl`,
 * so they are not repeated here). Reads go straight to D1: the board shows the
 * real purge counter and must not display a copy cached in another colo.
 *
 * One code guards the whole control plane (`system:cache:manage`): the page read
 * itself is a single-row `settings` lookup, but the purge button behind it costs a
 * 22,013-row rebuild on the next requests, so a read-only variant would only add a
 * permanently disabled purge button.
 */
import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {readAppCacheControlDirect} from "@/server/cache/cache-control";
import {jsonResponse} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

export const GET: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.SYSTEM_CACHE_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  return jsonResponse(
    {control: await readAppCacheControlDirect()},
    {headers: {"cache-control": "private, no-store"}},
  );
};
