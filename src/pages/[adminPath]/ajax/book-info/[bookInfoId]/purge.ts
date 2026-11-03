import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {BookInfoDb} from "@/server/book-info/types";
import {purgeBookInfoHandler} from "@/server/book-info/handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * `DELETE` 物理删除一条书本信息：只删**已软删**的行，不可恢复。
 * 与上一级 `DELETE /ajax/book-info/[bookInfoId]`（软删）分开两个 URL：
 * 破坏力差一个量级。独立模块，不碰公共缓存。
 */
export const DELETE: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_BOOK_DELETE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  try {
    const result = await purgeBookInfoHandler(
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
