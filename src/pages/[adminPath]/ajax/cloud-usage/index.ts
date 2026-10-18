/**
 * Cloudflare 使用情况快照端点（`GET /{adminPath}/ajax/cloud-usage`）。
 *
 * 一次打开取一份完整快照：D1 / R2 / Workers 三个分区的周期、卡片与趋势。
 * 守 `system:cloud-usage:read`（与菜单行同码，migration 0123）。
 *
 * 失败语义按界面需要分成两种：
 *   - 未配置 Token / 密文解不开 / 账号 ID 缺失 → 正常返回引导态快照（`ok: true`）；
 *   - Cloudflare 接口整体失败 → `{ok: false, error}`，HTTP 仍为 200，前端据此
 *     显示错误卡与「重试」。CF 侧故障与这次请求的客户端无关；用 5xx 会让
 *     浏览器的网络面板把它误读成站点自身不可用。
 */
import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {getCloudUsageHandler} from "@/server/admin/cloud-usage-handlers";
import {jsonResponse} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {adminLanguageFromRequest} from "@/shared/AdminLanguage";
import {PERMISSION_CODES} from "@/shared/Constants";
import {AppError} from "@/shared/errors";
import {translate} from "@/shared/i18n";

/** 用量随时在变，任何中间层都不该留副本。 */
const NO_STORE = {"cache-control": "private, no-store"};

export const GET: APIRoute = async ({locals, request}) => {
  const denied = await requireRbac(
    locals,
    PERMISSION_CODES.SYSTEM_CLOUD_USAGE_READ,
    request,
    env.FEED_DB,
  );
  if (denied) return denied;

  try {
    const snapshot = await getCloudUsageHandler(env);
    return jsonResponse({ok: true, data: snapshot}, {headers: NO_STORE});
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return jsonResponse(
      {
        ok: false,
        error: translate(
          error.i18nKey,
          adminLanguageFromRequest(request),
          error.params,
        ),
      },
      {headers: NO_STORE},
    );
  }
};
