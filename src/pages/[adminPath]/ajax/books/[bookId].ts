import {cache, env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import {
  PUBLIC_CACHE_TAGS,
  purgePublicCache,
} from "@/server/cache/public-cache";
import type {BookDb} from "@/server/feed/extBook";
import {
  deleteBookHandler,
  updateBookHandler,
} from "@/server/admin/book-handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/** `PUT` edits one book; `DELETE` soft-deletes it (the primary channel is
 *  rejected — it is the site's own feed). */
export const PUT: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_BOOK_UPDATE, request, env.FEED_DB);
  if (guard) return guard;
  const bookId = params.bookId ?? "";
  const body = await request.json().catch(() => null);
  try {
    const book = await updateBookHandler(
      env.FEED_DB as unknown as BookDb,
      bookId,
      body,
    );
    await purgePublicCache([PUBLIC_CACHE_TAGS.PUBLIC], cache);
    return jsonResponse(book);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};

export const DELETE: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_BOOK_DELETE, request, env.FEED_DB);
  if (guard) return guard;
  try {
    const result = await deleteBookHandler(
      env.FEED_DB as unknown as BookDb,
      params.bookId ?? "",
    );
    await purgePublicCache([PUBLIC_CACHE_TAGS.PUBLIC], cache);
    return jsonResponse(result);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
