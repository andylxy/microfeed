import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {YaoAliaDb} from "@/server/yao-alia/types";
import {
  createYaoAliaHandler,
  listYaoAliaBoardHandler,
} from "@/server/yao-alia/handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * `GET` 返回整张 `yao_alia` 看板；`POST` 新建一条别名。
 *
 * 独立模块（ADR-0064）：只读写 `yao_alia`，不碰 items/channels/ext_tcm_aliases，
 * 因此**不**清公共缓存——它没有任何公开站影子，也不调 `purgeAppYaoAliasesCache`。
 * 看板是后台数据，返回 `no-store`。读走 `content:yao-alia:read`、写走
 * `content:yao-alia:manage`（专属码，不复用 `content:alias:*` / `content:yao:*`，
 * ADR-0064 决策 8）。与既有 /admin/aliases/ 三态看板授权边界独立。
 */
export const GET: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_YAO_ALIA_READ,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  try {
    const board = await listYaoAliaBoardHandler(
      env.FEED_DB as unknown as YaoAliaDb,
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
    PERMISSION_CODES.CONTENT_YAO_ALIA_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const body = await request.json().catch(() => null);
  try {
    const alia = await createYaoAliaHandler(
      env.FEED_DB as unknown as YaoAliaDb,
      body,
    );
    return jsonResponse(alia, {status: 201});
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
