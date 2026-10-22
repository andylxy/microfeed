import type {APIRoute} from "astro";

import {jsonResponse, localizedError, serviceError} from "@/server/http";
import {
  PUBLIC_CACHE_TAGS,
  purgePublicCache,
} from "@/server/cache/public-cache";
import type {BookStatusDb} from "@/server/feed/extBookStatus";
import {
  deleteBookStatusHandler,
  updateBookStatusHandler,
} from "@/server/admin/book-status-handlers";
import {cache, env} from "cloudflare:workers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/** The status code is the row key: `/ajax/book-statuses/<code>`. */
function parseCode(params: Record<string, string | undefined>): number | null {
  const raw = params.code ?? "";
  if (!/^\d{1,3}$/u.test(raw)) return null;
  const code = Number(raw);
  return Number.isInteger(code) && code > 0 ? code : null;
}

export const PUT: APIRoute = async ({locals, params, request}) => {
  const code = parseCode(params);
  if (code == null) {
    return localizedError(request, "errors.bookStatuses.notFound", 400);
  }
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_BOOK_STATUS_MANAGE, request, env.FEED_DB);
  if (guard) return guard;
  const parsed = await request.json().catch(() => null);
  try {
    const status = await updateBookStatusHandler(
      env.FEED_DB as unknown as BookStatusDb,
      code,
      parsed,
    );
    // A flag flip changes what the public pages render (and what the book
    // editor offers), so the cached public surface is purged either way.
    await purgePublicCache([PUBLIC_CACHE_TAGS.PUBLIC], cache);
    return jsonResponse(status);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};

export const DELETE: APIRoute = async ({locals, params, request}) => {
  const code = parseCode(params);
  if (code == null) {
    return localizedError(request, "errors.bookStatuses.notFound", 400);
  }
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_BOOK_STATUS_MANAGE, request, env.FEED_DB);
  if (guard) return guard;
  try {
    await deleteBookStatusHandler(
      env.FEED_DB as unknown as BookStatusDb,
      code,
    );
    await purgePublicCache([PUBLIC_CACHE_TAGS.PUBLIC], cache);
    return jsonResponse({});
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
