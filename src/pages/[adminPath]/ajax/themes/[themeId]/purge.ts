import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {appErrorResponse, jsonResponse} from "@/server/http";
import {AppError} from "@/shared/errors";
import {mediaBucket} from "@/server/media/storage";
import ThemeStore from "@/server/themes/ThemeStore";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * 主题物理删除（purge，ADR-0026 D4）。DELETE 动词保留给软删除；purge 走独立
 * POST：不拿查询参数决定破坏力。确认输入由 UI 的 PurgeConfirmDialog 负责。
 */
export const POST: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_SETTINGS_MANAGE, request, env.FEED_DB);
  if (guard) return guard;
  try {
    await new ThemeStore(env.FEED_DB).purgeVersion(
      params.themeId ?? "",
      mediaBucket(env),
    );
    return jsonResponse({});
  } catch (error) {
    if (error instanceof AppError) return appErrorResponse(request, error);
    return jsonResponse({
      error: error instanceof Error ? error.message : String(error),
    }, {status: 400});
  }
};
