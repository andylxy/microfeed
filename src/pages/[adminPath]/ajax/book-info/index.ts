import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {BookInfoDb} from "@/server/book-info/types";
import {
  createBookInfoHandler,
  listBookInfoBoardHandler,
} from "@/server/book-info/handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * `GET` 返回整张 `book_info` 看板；`POST` 新建一条。
 *
 * 独立模块（ADR-0058）：只读写 `book_info`，不碰 channels/items，因此**不**清
 * 公共缓存——它没有任何公开站影子。看板是后台数据，返回 `no-store`。
 */
export const GET: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_BOOK_READ,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  try {
    const board = await listBookInfoBoardHandler(
      env.FEED_DB as unknown as BookInfoDb,
      env.FEED_DB,
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

export const POST: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_BOOK_CREATE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const body = await request.json().catch(() => null);
  try {
    const bookInfo = await createBookInfoHandler(
      env.FEED_DB as unknown as BookInfoDb,
      env.FEED_DB,
      body,
    );
    return jsonResponse(bookInfo, {status: 201});
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
