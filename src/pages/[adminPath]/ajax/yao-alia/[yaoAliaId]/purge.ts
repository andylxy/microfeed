import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {YaoAliaDb} from "@/server/yao-alia/types";
import {purgeYaoAliaHandler} from "@/server/yao-alia/handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * `DELETE` 物理删除一条别名：只删**已软删**的行，不可恢复。
 * 与上一级 `DELETE /ajax/yao-alia/[yaoAliaId]`（软删）分开两个 URL：
 * 破坏力差一个量级。物删释放 `yao_alia_bie_ming` 唯一键，同名别名才可复用。
 * 独立模块，不碰公共缓存。
 */
export const DELETE: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_YAO_ALIA_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  try {
    const result = await purgeYaoAliaHandler(
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
