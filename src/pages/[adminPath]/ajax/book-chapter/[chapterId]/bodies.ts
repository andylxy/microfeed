import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {BookChapterDb} from "@/server/book-chapter/types";
import {
  createBookChapterBodyHandler,
  listBookChapterBodiesHandler,
} from "@/server/book-chapter/handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * `GET` 返回某卷章下的正文列表（含已软删，`isDeleted` 区分）；`POST` 新建一条正文。
 *
 * 走 `book_chapter_id` 索引窄范围取（0181 索引），不整表扫 8066 行。
 */
export const GET: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_BOOK_CHAPTER_READ,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  try {
    const result = await listBookChapterBodiesHandler(
      env.FEED_DB as unknown as BookChapterDb,
      params.chapterId ?? "",
    );
    return jsonResponse(result, {headers: {"cache-control": "private, no-store"}});
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};

export const POST: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_BOOK_CHAPTER_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const body = await request.json().catch(() => null);
  try {
    const created = await createBookChapterBodyHandler(
      env.FEED_DB as unknown as BookChapterDb,
      params.chapterId ?? "",
      body,
    );
    return jsonResponse(created, {status: 201});
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
