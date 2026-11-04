import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {MingCiDb} from "@/server/ming-ci/types";
import {reassignMingCiGroupHandler} from "@/server/ming-ci/handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * `POST` 改派：把 `from` 组的整批名词挪到 `to` 组（删组前先改派，ADR-0060 决策 4）。
 * `from`/`to` 都须在当前分组清单内（防改派到不存在分组产生游离类）。
 */
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
    const result = await reassignMingCiGroupHandler(
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
