import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import {
  listCategoryNav,
  listChannelsByGenre,
} from "@/server/feed/extCategory";
import type {CategoryDb} from "@/server/feed/extCategory";
import {listFangBoard, listFangBooks} from "@/server/feed/extFang";
import type {VolumeDb} from "@/server/feed/extVolume";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * `GET ?bookId=<id>` returns the book picker plus that book's fang board.
 * `GET ?categoryId=<id>` narrows the picker to that category's books; the
 * response always carries the category nav so the board can offer the same
 * filtering the public shelf does. Without `bookId` only the picker is returned.
 */
export const GET: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_FANG_READ,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
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
      : await listFangBooks(db);
    const board = bookId ? await listFangBoard(db, bookId) : null;
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
