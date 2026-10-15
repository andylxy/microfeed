import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {VolumeDb} from "@/server/feed/extVolume";
import {listVolumeEntriesHandler} from "@/server/admin/volume-handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * `GET ?bookId=<id>&volume=<key>` returns one volume's entries — every entry the
 * volume has, in reading order, with no paging.
 *
 * This is the second request the board makes: the first (see `./index.ts`) lists
 * the book's volumes without any entry rows, and expanding one volume reads that
 * volume alone. The volume key must belong to the book; a key that does not is
 * answered with an empty list, so a stale bookmark or a hand-edited URL cannot
 * make the server read another book's entries.
 */
export const GET: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_VOLUME_READ, request, env.FEED_DB);
  if (guard) return guard;
  const url = new URL(request.url);
  const bookId = url.searchParams.get("bookId") ?? "";
  const volume = url.searchParams.get("volume") ?? "";
  try {
    const db = env.FEED_DB as unknown as VolumeDb;
    const entries = await listVolumeEntriesHandler(db, bookId, volume);
    return jsonResponse(entries, {headers: {"cache-control": "private, no-store"}});
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
