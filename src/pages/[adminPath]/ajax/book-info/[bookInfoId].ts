import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {BookInfoDb} from "@/server/book-info/types";
import {
  deleteBookInfoHandler,
  updateBookInfoHandler,
} from "@/server/book-info/handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * `PUT` 编辑一条书本信息；`DELETE` 软删（写 `deleted_at`，行保留）。
 * 独立模块：不碰公共缓存。软删与物删分两个 URL（`/purge`），
 * 破坏力差一个量级，共用一个入口只会让误点一次就烧掉行。
 */
export const PUT: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_BOOK_UPDATE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const body = await request.json().catch(() => null);
  try {
    const bookInfo = await updateBookInfoHandler(
      env.FEED_DB as unknown as BookInfoDb,
      env.FEED_DB,
      params.bookInfoId ?? "",
      body,
    );
    return jsonResponse(bookInfo);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};

export const DELETE: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_BOOK_DELETE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  try {
    const result = await deleteBookInfoHandler(
      env.FEED_DB as unknown as BookInfoDb,
      params.bookInfoId ?? "",
    );
    return jsonResponse(result);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
