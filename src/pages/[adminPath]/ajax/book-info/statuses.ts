import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import {listBookStatusesHandler, saveBookStatusesHandler} from "@/server/book-info/handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * 状态清单（迁移 0173/0174）：`GET` 读整份、`PUT` 整表覆盖写（增删改名排序都是它）。
 *
 * 状态存 `settings.book_info_statuses`，独立管理、不依赖 channels/items/ext_*。
 * 权限全复用 `content:book:*`，不加新码（ADR-0058 决策 4）。独立模块，不碰公共缓存。
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
    const statuses = await listBookStatusesHandler(env.FEED_DB);
    return jsonResponse(
      {statuses},
      {headers: {"cache-control": "private, no-store"}},
    );
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};

export const PUT: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_BOOK_UPDATE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const body = await request.json().catch(() => null);
  try {
    const result = await saveBookStatusesHandler(env.FEED_DB, body);
    return jsonResponse(result);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
