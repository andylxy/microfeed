import {cache, env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, localizedError, serviceError} from "@/server/http";
import {
  PUBLIC_CACHE_TAGS,
  purgePublicCache,
} from "@/server/cache/public-cache";
import type {BookDb} from "@/server/feed/extBook";
import {purgeBookHandler} from "@/server/admin/book-handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * `DELETE` 物理删除一本书：连它的章节一起清库，不可恢复。
 *
 * 与上一级的 `DELETE /ajax/books/[bookId]`（软删除：状态切到字典里的删除态）分开
 * 两个 URL：两者破坏力差一个量级，共用一个入口只会让误点一次就烧掉章节。主频道拒绝。
 */
export const DELETE: APIRoute = async ({locals, params, request}) => {
  if (!params.bookId) {
    return localizedError(request, "errors.books.notFound", 400);
  }
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_BOOK_DELETE, request, env.FEED_DB);
  if (guard) return guard;
  try {
    const result = await purgeBookHandler(
      env.FEED_DB as unknown as BookDb,
      params.bookId,
    );
    // 章节行没了，搜索影子表与书架缓存都要跟着清。
    await purgePublicCache([PUBLIC_CACHE_TAGS.PUBLIC], cache);
    return jsonResponse(result);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
