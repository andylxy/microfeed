import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {MingCiDb} from "@/server/ming-ci/types";
import {
  deleteMingCiHandler,
  updateMingCiHandler,
} from "@/server/ming-ci/handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * `PUT` 编辑一条名词；`DELETE` 软删（写 `deleted_at`，行保留）。
 * 独立模块：不碰公共缓存。软删与物删分两个 URL（`/purge`），
 * 破坏力差一个量级，共用一个入口只会让误点一次就烧掉行。
 */
export const PUT: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_TERM_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const body = await request.json().catch(() => null);
  try {
    const noun = await updateMingCiHandler(
      env.FEED_DB as unknown as MingCiDb,
      env.FEED_DB,
      params.mingCiId ?? "",
      body,
    );
    return jsonResponse(noun);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};

export const DELETE: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_TERM_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  try {
    const result = await deleteMingCiHandler(
      env.FEED_DB as unknown as MingCiDb,
      params.mingCiId ?? "",
    );
    return jsonResponse(result);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
