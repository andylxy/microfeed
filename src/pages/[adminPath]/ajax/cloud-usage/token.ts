/**
 * Cloudflare API Token 管理端点（`GET|POST|DELETE /{adminPath}/ajax/cloud-usage/token`）。
 *
 * - `GET`    读取状态，只回 `{configured, tokenHint, updatedAtMs}`；
 * - `POST`   body `{token: string}`，校验 → 加密 → 单行 upsert；
 * - `DELETE` 删除密文行，仪表盘回到引导态。
 *
 * 三个动作统一守 `content:settings:manage`（与站点设置同级）。该权限不在
 * editor / readonly 的权限列表里，实际只有 super_admin 能管。
 *
 * 响应信封 `{ok, data}` / `{ok: false, error}`。**永不返回密文或明文**：
 * 状态里的 `tokenHint` 只有末四位。
 */
import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {
  clearCloudflareToken,
  cloudflareTokenStatus,
  saveCloudflareToken,
  type CloudflareTokenStatus,
} from "@/server/cloud-usage/token-store";
import {jsonResponse} from "@/server/http";
import {requireRbac, type RbacLocals} from "@/server/rbac/guard";
import {adminLanguageFromRequest} from "@/shared/AdminLanguage";
import {PERMISSION_CODES} from "@/shared/Constants";
import {AppError} from "@/shared/errors";
import {translate} from "@/shared/i18n";

/** 这枚 Token 是秘密，任何中间层都不该留副本。 */
const NO_STORE = {"cache-control": "private, no-store"};

function ok(status: CloudflareTokenStatus): Response {
  return jsonResponse({ok: true, data: status}, {headers: NO_STORE});
}

/**
 * 域错误按请求语言渲染成 `{ok: false, error}`。非域错误继续向上抛，交给框架
 * 的默认错误处理——在这里吞掉会让「D1 写失败」看起来像一次普通的校验失败。
 */
function failure(error: unknown, request: Request): Response {
  if (!(error instanceof AppError)) throw error;
  return jsonResponse(
    {
      ok: false,
      error: translate(error.i18nKey, adminLanguageFromRequest(request), error.params),
    },
    {status: error.status, headers: NO_STORE},
  );
}

async function guard(locals: RbacLocals, request: Request): Promise<Response | null> {
  return requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_SETTINGS_MANAGE,
    request,
    env.FEED_DB,
  );
}

export const GET: APIRoute = async ({locals, request}) => {
  const denied = await guard(locals, request);
  if (denied) return denied;
  return ok(await cloudflareTokenStatus(env));
};

export const POST: APIRoute = async ({locals, request}) => {
  const denied = await guard(locals, request);
  if (denied) return denied;

  const body = await request.json().catch(() => null) as {token?: unknown} | null;
  if (!body || typeof body.token !== "string") {
    return failure(new AppError("errors.cloudUsage.invalidToken"), request);
  }
  try {
    return ok(await saveCloudflareToken(env, body.token));
  } catch (error) {
    return failure(error, request);
  }
};

export const DELETE: APIRoute = async ({locals, request}) => {
  const denied = await guard(locals, request);
  if (denied) return denied;
  try {
    return ok(await clearCloudflareToken(env));
  } catch (error) {
    return failure(error, request);
  }
};
