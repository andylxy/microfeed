import {cache, env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import {
  PUBLIC_CACHE_TAGS,
  purgePublicCache,
} from "@/server/cache/public-cache";
import type {BookStatusDb} from "@/server/feed/extBookStatus";
import {countChannelsByStatus} from "@/server/feed/extBookStatus";
import {
  createBookStatusHandler,
  listBookStatusesHandler,
} from "@/server/admin/book-status-handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/** `GET` returns every status plus its book count; `POST` adds a status. */
export const GET: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_BOOK_STATUS_MANAGE, request, env.FEED_DB);
  if (guard) return guard;
  try {
    const statuses = await listBookStatusesHandler(
      env.FEED_DB as unknown as BookStatusDb,
    );
    const usage = await countChannelsByStatus(
      env.FEED_DB as unknown as BookStatusDb,
    );
    return jsonResponse(
      {statuses, usage: Object.fromEntries(usage)},
      {headers: {"cache-control": "private, no-store"}},
    );
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};

export const POST: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_BOOK_STATUS_MANAGE, request, env.FEED_DB);
  if (guard) return guard;
  const body = await request.json().catch(() => null);
  try {
    const status = await createBookStatusHandler(
      env.FEED_DB as unknown as BookStatusDb,
      body,
    );
    // The shelf / category / detail pages are cached: a status flagged
    // public-visible changes what they render, so they have to be purged.
    await purgePublicCache([PUBLIC_CACHE_TAGS.PUBLIC], cache);
    return jsonResponse(status, {status: 201});
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
