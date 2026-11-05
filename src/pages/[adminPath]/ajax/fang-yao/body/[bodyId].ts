import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {FangYaoDb} from "@/server/fang-yao/types";
import {
  deleteFangYaoBodyHandler,
  getFangYaoBodyHandler,
  updateFangYaoBodyHandler,
} from "@/server/fang-yao/handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * `GET` 读一条组成；`PUT` 编辑；`DELETE` 软删（写 `deleted_at`，行保留）。
 * 独立模块：不碰公共缓存。软删与物删分两个 URL（`/purge`）。
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
    const body = await getFangYaoBodyHandler(
      env.FEED_DB as unknown as FangYaoDb,
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
    PERMISSION_CODES.CONTENT_FANG_YAO_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const payload = await request.json().catch(() => null);
  try {
    const body = await updateFangYaoBodyHandler(
      env.FEED_DB as unknown as FangYaoDb,
      params.bodyId ?? "",
      payload,
    );
    return jsonResponse(body);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};

export const DELETE: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_FANG_YAO_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  try {
    const result = await deleteFangYaoBodyHandler(
      env.FEED_DB as unknown as FangYaoDb,
      params.bodyId ?? "",
    );
    return jsonResponse(result);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
