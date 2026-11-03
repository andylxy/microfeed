import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import {listBookGroupsHandler, saveBookGroupsHandler} from "@/server/book-info/handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * 分组清单（ADR-0059）：`GET` 读整份、`PUT` 整表覆盖写（增删改名排序都是它）。
 *
 * 分组存 `settings.book_groups`，独立管理、不依赖 channels/items/ext_category。
 * 权限全复用 `content:book:*`，不加新码（ADR-0059 决策 6）。独立模块，不碰公共缓存。
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
    const groups = await listBookGroupsHandler(env.FEED_DB);
    return jsonResponse(
      {groups},
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
    const result = await saveBookGroupsHandler(env.FEED_DB, body);
    return jsonResponse(result);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
