import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {YaoAliaDb} from "@/server/yao-alia/types";
import {
  deleteYaoAliaHandler,
  updateYaoAliaHandler,
} from "@/server/yao-alia/handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * `PUT` 编辑一条别名；`DELETE` 软删（写 `deleted_at`，行保留）。
 * 独立模块：不碰公共缓存。软删与物删分两个 URL（`/purge`），
 * 破坏力差一个量级，共用一个入口只会让误点一次就烧掉行。
 * 编辑 `yaoName` 后左栏分组即时重算（UI 客户端派生，无 settings 写入）。
 */
export const PUT: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_YAO_ALIA_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const body = await request.json().catch(() => null);
  try {
    const alia = await updateYaoAliaHandler(
      env.FEED_DB as unknown as YaoAliaDb,
      params.yaoAliaId ?? "",
      body,
    );
    return jsonResponse(alia);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};

export const DELETE: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_YAO_ALIA_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  try {
    const result = await deleteYaoAliaHandler(
      env.FEED_DB as unknown as YaoAliaDb,
      params.yaoAliaId ?? "",
    );
    return jsonResponse(result);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
