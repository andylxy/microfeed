import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {MingCiDb} from "@/server/ming-ci/types";
import {
  createMingCiHandler,
  listMingCiBoardHandler,
} from "@/server/ming-ci/handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * `GET` 返回整张 `ming_ci` 看板；`POST` 新建一条。
 *
 * 独立模块（ADR-0060）：只读写 `ming_ci`（+ 读 settings 分组与 book_info 来源书），
 * 不碰 items/channels，因此**不**清公共缓存——它没有任何公开站影子。看板是
 * 后台数据，返回 `no-store`。读走 `content:term:read`、写走 `content:term:manage`
 * （term 只有 read/manage 两码，无 create/update/delete 分离——ADR-0060 决策 6）。
 */
export const GET: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_TERM_READ,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  try {
    const board = await listMingCiBoardHandler(
      env.FEED_DB as unknown as MingCiDb,
      env.FEED_DB,
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
    PERMISSION_CODES.CONTENT_TERM_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const body = await request.json().catch(() => null);
  try {
    const noun = await createMingCiHandler(
      env.FEED_DB as unknown as MingCiDb,
      env.FEED_DB,
      body,
    );
    return jsonResponse(noun, {status: 201});
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
