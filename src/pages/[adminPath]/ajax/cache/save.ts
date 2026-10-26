/**
 * Cache control write (`POST /admin/ajax/cache/save`).
 *
 * Body: `{patch: {enabled?, ttls?, buckets?, maxEntryBytes?}}` — read-merge-write
 * via `saveAppCacheControl`. Out-of-range or wrong-typed values are rejected with
 * a clean 400 (discriminated result, no throw); nothing is silently clamped, so a
 * 30-second content TTL shows an error instead of a value the page did not ask
 * for.
 *
 * Saving only affects entries written afterwards: existing entries keep the
 * `max-age` they were stored with. The page tells the operator to purge after a
 * TTL change.
 */
import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {saveAppCacheControl} from "@/server/cache/cache-control";
import {jsonResponse, localizedError} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

export const POST: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.SYSTEM_CACHE_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const body = await request.json().catch(() => null) as
    | {patch?: unknown}
    | null;
  const result = await saveAppCacheControl(body?.patch ?? {});
  if (!result.ok) {
    return localizedError(request, "errors.cache.invalidControl", 400);
  }
  return jsonResponse({control: result.control});
};
