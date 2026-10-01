import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import {listTcmEntryBoard, listTcmEntryBooks} from "@/server/feed/extTcmEntries";
import type {VolumeDb} from "@/server/feed/extVolume";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * `GET ?bookId=<id>` returns the book picker plus that book's 中药 (yao) board.
 * Without `bookId` only the picker is returned. The board is read-only; each row
 * links out to the item editor.
 */
export const GET: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_YAO_READ,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const url = new URL(request.url);
  const bookId = url.searchParams.get("bookId") ?? "";
  try {
    const db = env.FEED_DB as unknown as VolumeDb;
    const books = await listTcmEntryBooks(db, "yao");
    const board = bookId ? await listTcmEntryBoard(db, bookId, "yao") : null;
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
