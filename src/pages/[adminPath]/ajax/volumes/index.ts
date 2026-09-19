import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {VolumeDb} from "@/server/feed/extVolume";
import {
  listVolumeBoardHandler,
  listVolumeBooksHandler,
} from "@/server/admin/volume-handlers";

/** `GET ?bookId=<id>` returns the book picker plus that book's volume board.
 *  Without `bookId` only the picker is returned. */
export const GET: APIRoute = async ({request}) => {
  const url = new URL(request.url);
  const bookId = url.searchParams.get("bookId") ?? "";
  try {
    const db = env.FEED_DB as unknown as VolumeDb;
    const books = await listVolumeBooksHandler(db);
    const board = bookId
      ? await listVolumeBoardHandler(db, bookId)
      : null;
    return jsonResponse(
      {board, books},
      {headers: {"cache-control": "private, no-store"}},
    );
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
