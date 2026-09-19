import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {BookDb} from "@/server/feed/extBook";
import {
  deleteBookHandler,
  updateBookHandler,
} from "@/server/admin/book-handlers";

/** `PUT` edits one book; `DELETE` soft-deletes it (the primary channel is
 *  rejected — it is the site's own feed). */
export const PUT: APIRoute = async ({params, request}) => {
  const bookId = params.bookId ?? "";
  const body = await request.json().catch(() => null);
  try {
    const book = await updateBookHandler(
      env.FEED_DB as unknown as BookDb,
      bookId,
      body,
    );
    return jsonResponse(book);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};

export const DELETE: APIRoute = async ({params}) => {
  try {
    const result = await deleteBookHandler(
      env.FEED_DB as unknown as BookDb,
      params.bookId ?? "",
    );
    return jsonResponse(result);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
