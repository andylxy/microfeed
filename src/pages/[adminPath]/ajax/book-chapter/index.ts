import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {BookChapterDb} from "@/server/book-chapter/types";
import {
  createBookChapterHandler,
  listBookChapterBoardHandler,
} from "@/server/book-chapter/handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * `GET` 返回卷章看板（分类清单 + 来源书下拉 + 445 卷章目录）；`POST` 新建一条卷章。
 *
 * 独立模块（ADR-0062）：只读写 `book_chapter`/`book_chapter_body`（+ 只读
 * `book_info`/`settings.book_groups` 供左栏三层导航），不碰 items/channels/
 * zhong_yao，因此**不**清公共缓存——它没有任何公开站影子。看板是后台数据，
 * 返回 `no-store`。
 *
 * 读走 `content:book-chapter:read`、写走 `content:book-chapter:manage`。
 * 正文不在看板里（8066 行太重），走 `[chapterId]/bodies` 按卷章窄范围取。
 */
export const GET: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_BOOK_CHAPTER_READ,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  try {
    const board = await listBookChapterBoardHandler(
      env.FEED_DB as unknown as BookChapterDb,
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
    PERMISSION_CODES.CONTENT_BOOK_CHAPTER_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const body = await request.json().catch(() => null);
  try {
    const chapter = await createBookChapterHandler(
      env.FEED_DB as unknown as BookChapterDb,
      body,
    );
    return jsonResponse(chapter, {status: 201});
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
