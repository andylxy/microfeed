import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {MingCiDb} from "@/server/ming-ci/types";
import {
  listMingCiGroupsHandler,
  saveMingCiGroupsHandler,
} from "@/server/ming-ci/handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * `GET` 读分组清单（settings `mingci_groups`）；`PUT` 整表覆盖写。
 * 独立模块：不碰公共缓存。写侧严格校验（空清单 400、删组前 COUNT>0 拒删）。
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
    const groups = await listMingCiGroupsHandler(env.FEED_DB);
    return jsonResponse(
      {groups},
      {headers: {"cache-control": "private, no-store"}},
    );
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};

export const PUT: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_TERM_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const body = await request.json().catch(() => null);
  try {
    const result = await saveMingCiGroupsHandler(
      env.FEED_DB as unknown as MingCiDb,
      env.FEED_DB,
      body,
    );
    return jsonResponse(result);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
