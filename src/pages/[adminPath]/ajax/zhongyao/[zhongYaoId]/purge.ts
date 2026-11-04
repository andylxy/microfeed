import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {ZhongYaoDb} from "@/server/zhong-yao/types";
import {purgeZhongYaoHandler} from "@/server/zhong-yao/handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * `DELETE` 物理删除一条**已软删**的本草（两步删除第二段，不可恢复）。
 * 与 `PUT`/`DELETE` 分 URL：软删与物删破坏力差一个量级。
 */
export const DELETE: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_YAO_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  try {
    const result = await purgeZhongYaoHandler(
      env.FEED_DB as unknown as ZhongYaoDb,
      params.zhongYaoId ?? "",
    );
    return jsonResponse(result);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
