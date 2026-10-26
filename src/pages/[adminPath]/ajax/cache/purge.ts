/**
 * Cache purge (`POST /admin/ajax/cache/purge`).
 *
 * Body: `{scope?: "all" | AppCacheBucket}` — omitted means "everything". The
 * purge itself goes through `cache.purge({tags})` so it applies to every colo in
 * one call; the pricing and the reasons for the tag scheme live in
 * `src/server/cache/cache-purge.ts`.
 *
 * Status codes:
 *   200  accepted (purge is asynchronous; takes effect within about a minute)
 *   400  unknown bucket
 *   429  inside the 10-second interval, or the 30/day budget is used up
 *   502  the purge call failed — the raw errors are returned so the operator
 *        can see why (local miniflare does not support purge, for example)
 */
import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {
  isAppCachePurgeScope,
  purgeAppCache,
} from "@/server/cache/cache-purge";
import {jsonResponse, localizedError} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {adminLanguageFromRequest} from "@/shared/AdminLanguage";
import {PERMISSION_CODES} from "@/shared/Constants";
import {translate} from "@/shared/i18n";
import {PURGE_DAILY_MAX} from "@/shared/AppCacheControl";

export const POST: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.SYSTEM_CACHE_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  // 空体按「清空全部」处理（与页面无参调用一致）；体存在但解析不了时返回 400，
  // 不能当成 `all`——坏请求体不该升级成全局清空。
  const raw = await request.text();
  let scope: unknown = "all";
  if (raw.trim() !== "") {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return localizedError(request, "errors.cache.invalidScope", 400);
    }
    scope = (body as {scope?: unknown} | null)?.scope ?? "all";
  }
  if (!isAppCachePurgeScope(scope)) {
    return localizedError(request, "errors.cache.invalidScope", 400);
  }
  const result = await purgeAppCache(scope);
  if (result.ok) {
    return jsonResponse({control: result.control, ok: true, tags: result.tags});
  }
  if (result.reason === "throttled") {
    const seconds = String(Math.ceil(result.retryAfterMs / 1_000));
    return localizedError(
      request,
      "errors.cache.purgeThrottled",
      429,
      {seconds},
      {headers: {"retry-after": seconds}},
    );
  }
  if (result.reason === "dailyLimit") {
    return localizedError(
      request,
      "errors.cache.purgeDailyLimit",
      429,
      {max: String(PURGE_DAILY_MAX)},
    );
  }
  return jsonResponse(
    {
      error: translate(
        "errors.cache.purgeFailed",
        adminLanguageFromRequest(request),
      ),
      errors: result.errors,
    },
    {status: 502},
  );
};
