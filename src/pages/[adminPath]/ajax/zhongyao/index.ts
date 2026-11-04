import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {ZhongYaoDb} from "@/server/zhong-yao/types";
import {
  createZhongYaoHandler,
  listZhongYaoBoardHandler,
} from "@/server/zhong-yao/handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * `GET` 返回整张 `zhong_yao` 看板；`POST` 新建一条。
 *
 * 独立模块（ADR-0061）：只读写 `zhong_yao`，不碰 items/channels，因此**不**清公共
 * 缓存——它没有任何公开站影子。看板是后台数据，返回 `no-store`。读走
 * `content:yao:read`、写走 `content:yao:manage`（复用既有中药两码，不加新码——
 * ADR-0061 决策 7）。
 */
export const GET: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_YAO_READ,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  try {
    const board = await listZhongYaoBoardHandler(
      env.FEED_DB as unknown as ZhongYaoDb,
    );
    return jsonResponse(
      board,
      {headers: {"cache-control": "private, no-store"}},
    );
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};

export const POST: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_YAO_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const body = await request.json().catch(() => null);
  try {
    const herb = await createZhongYaoHandler(
      env.FEED_DB as unknown as ZhongYaoDb,
      body,
    );
    return jsonResponse(herb, {status: 201});
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
