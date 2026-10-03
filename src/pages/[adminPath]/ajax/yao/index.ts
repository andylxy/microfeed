/**
 * 中药 board read端点 + actions.
 *
 * `GET ?bookId=[&deleted=1]` returns the book picker plus that book's 中药 board
 * (the recycle view when `deleted=1`). Writes live in sibling action files —
 * `action.ts` (add / update / soft-delete, all POST) and `restore.ts` — because
 * this project routes admin verbs per-file; an `export const PUT` on `index.ts`
 * is not routed. Guards live on the handler module.
 */
import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import {listTcmEntryBoard, listTcmEntryBooks} from "@/server/feed/extTcmEntries";
import type {VolumeDb} from "@/server/feed/extVolume";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

const KIND = "yao";

/** `GET ?bookId=<id>[&deleted=1]` — picker only when `bookId` is absent. */
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
  const includeDeleted = url.searchParams.get("deleted") === "1";
  try {
    const db = env.FEED_DB as unknown as VolumeDb;
    const books = await listTcmEntryBooks(db, KIND);
    const board = bookId
      ? await listTcmEntryBoard(db, bookId, KIND, includeDeleted)
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
