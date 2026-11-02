/**
 * 注册来源（分组）配置的写端点。
 *
 * 路由文件只做再导出（与 `ajax/rbac/users.ts` 同款），策略留在这里——保存闸门
 * 不是 HTTP 细节，它守的是「`auth_user.signup_source` 恒落在列表内」这条数据
 * 约束。
 *
 * 两道闸门（`checkSignupSourceRemoval`）：
 *   1. 建号链路写死的 `admin` / `email` / `qq` 不可删除；
 *   2. 仍有账号在用的来源不可删除——先让那些账号改到别的来源。
 *
 * 只挂 `system:user:manage`：能管账号的人本来就该能管分组，不另立权限码。
 */
import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {
  countAccountsBySource,
  getSignupSources,
  setSignupSources,
} from "@/server/auth/signup-source";
import {jsonResponse, localizedError} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";
import {
  classifyRemovedSources,
  removedSources,
  validateSignupSources,
} from "@/shared/SignupSource";

export const updateAdminSignupSources: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.SYSTEM_USER_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;

  const body = await request.json().catch(() => null) as {sources?: unknown} | null;
  if (!body || !validateSignupSources(body.sources)) {
    return localizedError(request, "errors.rbac.invalidSignupSources", 400);
  }
  const next = body.sources;

  const current = await getSignupSources(env.FEED_DB);
  const removed = removedSources(current, next);
  const {builtinRemoved, inUse} = classifyRemovedSources(
    removed,
    await countAccountsBySource(env.FEED_DB, removed),
  );
  if (builtinRemoved.length > 0) {
    return localizedError(request, "errors.rbac.builtinSignupSourceRequired", 400, {
      values: builtinRemoved.join(", "),
    });
  }
  if (inUse[0]) {
    return localizedError(request, "errors.rbac.signupSourceInUse", 409, {
      count: String(inUse[0].count),
      value: inUse[0].value,
    });
  }

  await setSignupSources(env.FEED_DB, next);
  // 直接回提交的列表：刚写进去的就是它，再读一次只是多一条查询。
  return jsonResponse({sources: next});
};
