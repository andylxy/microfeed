import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {BookInfoDb} from "@/server/book-info/types";
import {reassignBookGroupHandler} from "@/server/book-info/handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * 改派（ADR-0059）：把一个组的书整批挪到另一个组。删组前先改派——
 * `case_division` NOT NULL，不能让书悬空。
 *
 * body `{from, to}`。权限复用 `content:book:update`（改的是书的分组归属）。
 * 独立模块，不碰公共缓存。
 */
export const POST: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_BOOK_UPDATE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const body = await request.json().catch(() => null);
  try {
    const result = await reassignBookGroupHandler(
      env.FEED_DB as unknown as BookInfoDb,
      body,
    );
    return jsonResponse(result);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
