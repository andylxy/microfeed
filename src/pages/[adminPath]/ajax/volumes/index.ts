import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {VolumeDb} from "@/server/feed/extVolume";
import {
  listVolumeBoardHandler,
  listVolumeBooksHandler,
} from "@/server/admin/volume-handlers";
import {
  listCategoryNav,
  listChannelsByGenre,
} from "@/server/feed/extCategory";
import type {CategoryDb} from "@/server/feed/extCategory";

/**
 * `GET ?bookId=<id>` returns the book picker plus that book's volume board.
 * `GET ?categoryId=<id>` narrows the picker to that category's books, and the
 * response always carries the category nav so the board can offer the same
 * filtering the public shelf does. Without `bookId` only the picker is returned.
 */
export const GET: APIRoute = async ({request}) => {
  const url = new URL(request.url);
  const bookId = url.searchParams.get("bookId") ?? "";
  const categoryId = url.searchParams.get("categoryId") ?? "";
  try {
    const db = env.FEED_DB as unknown as VolumeDb;
    const categories = await listCategoryNav(
      env.FEED_DB as unknown as CategoryDb,
    );
    const books = categoryId
      ? (await listChannelsByGenre(
          env.FEED_DB as unknown as CategoryDb,
          categoryId,
        )).map((book) => ({id: book.id, title: book.title}))
      : await listVolumeBooksHandler(db);
    const board = bookId ? await listVolumeBoardHandler(db, bookId) : null;
    return jsonResponse(
      {board, books, categories},
      {headers: {"cache-control": "private, no-store"}},
    );
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
