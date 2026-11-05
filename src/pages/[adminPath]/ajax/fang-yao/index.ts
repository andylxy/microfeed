import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {FangYaoDb} from "@/server/fang-yao/types";
import {
  createFangYaoHandler,
  listFangYaoBoardHandler,
} from "@/server/fang-yao/handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * `GET` 返回方剂看板（源书分组 + 804 方剂目录）；`POST` 新建一条方剂。
 *
 * 独立模块（ADR-0065）：只读写 `fang_yao`/`fang_yao_body`，不碰 items/channels/
 * zhong_yao/book_chapter，因此**不**清公共缓存——它没有任何公开站影子。看板是
 * 后台数据，返回 `no-store`。
 *
 * 读走 `content:fang-yao:read`、写走 `content:fang-yao:manage`。左栏「源书 → 方」
 * 两层树的组聚合由 `listFangYaoBoardHandler` 内部派生（只读 `fang_yao`，不联动
 * `book_info`），故本端点只传 `env.FEED_DB`，无 sourceDb。组成不在看板里
 * （2025 行偏重），走 `[fangId]/bodies` 按方剂窄范围取。
 */
export const GET: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_FANG_YAO_READ,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  try {
    const board = await listFangYaoBoardHandler(
      env.FEED_DB as unknown as FangYaoDb,
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
    PERMISSION_CODES.CONTENT_FANG_YAO_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const body = await request.json().catch(() => null);
  try {
    const formula = await createFangYaoHandler(
      env.FEED_DB as unknown as FangYaoDb,
      body,
    );
    return jsonResponse(formula, {status: 201});
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
