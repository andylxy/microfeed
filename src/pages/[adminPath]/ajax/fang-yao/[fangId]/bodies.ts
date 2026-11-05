import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {FangYaoDb} from "@/server/fang-yao/types";
import {
  createFangYaoBodyHandler,
  listFangYaoBodiesHandler,
} from "@/server/fang-yao/handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * `GET` 返回某方剂下的组成列表（含已软删，`isDeleted` 区分）；`POST` 新建一条组成。
 *
 * 走 `fang_yao_id` 索引窄范围取（0184 索引），不整表扫 2025 行。
 */
export const GET: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_FANG_YAO_READ,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  try {
    const result = await listFangYaoBodiesHandler(
      env.FEED_DB as unknown as FangYaoDb,
      params.fangId ?? "",
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
    PERMISSION_CODES.CONTENT_FANG_YAO_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const body = await request.json().catch(() => null);
  try {
    const created = await createFangYaoBodyHandler(
      env.FEED_DB as unknown as FangYaoDb,
      params.fangId ?? "",
      body,
    );
    return jsonResponse(created, {status: 201});
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
