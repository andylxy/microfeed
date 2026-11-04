import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {BookChapterDb} from "@/server/book-chapter/types";
import {purgeBookChapterBodyHandler} from "@/server/book-chapter/handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * `DELETE` 物理删除一条**已软删**的正文（两步删除第二段，不可恢复）。
 */
export const DELETE: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_BOOK_CHAPTER_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  try {
    const result = await purgeBookChapterBodyHandler(
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
