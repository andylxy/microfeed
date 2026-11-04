import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {BookChapterDb} from "@/server/book-chapter/types";
import {
  deleteBookChapterBodyHandler,
  getBookChapterBodyHandler,
  updateBookChapterBodyHandler,
} from "@/server/book-chapter/handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * `GET` 读一条正文；`PUT` 编辑；`DELETE` 软删（写 `deleted_at`，行保留）。
 *
 * 路径挂在静态段 `body/` 下（与 `[chapterId].ts` 同级不冲突）：正文有自己的
 * 主键，单行读写不需要再带上卷章 id。软删与物删分两个 URL（`/purge`）。
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
    const body = await getBookChapterBodyHandler(
      env.FEED_DB as unknown as BookChapterDb,
      params.bodyId ?? "",
    );
    return jsonResponse(body);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};

export const PUT: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_BOOK_CHAPTER_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const body = await request.json().catch(() => null);
  try {
    const updated = await updateBookChapterBodyHandler(
      env.FEED_DB as unknown as BookChapterDb,
      params.bodyId ?? "",
      body,
    );
    return jsonResponse(updated);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};

export const DELETE: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_BOOK_CHAPTER_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  try {
    const result = await deleteBookChapterBodyHandler(
      env.FEED_DB as unknown as BookChapterDb,
      params.bodyId ?? "",
    );
    return jsonResponse(result);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
