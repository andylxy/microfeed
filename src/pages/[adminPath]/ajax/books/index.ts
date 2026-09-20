import {cache, env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import {
  PUBLIC_CACHE_TAGS,
  purgePublicCache,
} from "@/server/cache/public-cache";
import type {BookDb} from "@/server/feed/extBook";
import {
  createBookHandler,
  listBooksBoardHandler,
} from "@/server/admin/book-handlers";

/** `GET` returns every book plus the category picker; `POST` creates a book. */
export const GET: APIRoute = async () => {
  try {
    const board = await listBooksBoardHandler(
      env.FEED_DB as unknown as BookDb,
    );
    return jsonResponse(
      board,
      {headers: {"cache-control": "private, no-store"}},
    );
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};

export const POST: APIRoute = async ({request}) => {
  const body = await request.json().catch(() => null);
  try {
    const book = await createBookHandler(
      env.FEED_DB as unknown as BookDb,
      body,
    );
    // Books are channels, and the shelf/category pages are cached — without this
    // a new book stays invisible for the whole cache window.
    await purgePublicCache([PUBLIC_CACHE_TAGS.PUBLIC], cache);
    return jsonResponse(book, {status: 201});
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
