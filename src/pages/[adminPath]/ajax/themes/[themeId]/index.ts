import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {appErrorResponse, jsonResponse, localizedTextError} from "@/server/http";
import {AppError} from "@/shared/errors";
import {mediaBucket} from "@/server/media/storage";
import ThemeStore from "@/server/themes/ThemeStore";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

export const GET: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_SETTINGS_MANAGE, request, env.FEED_DB);
  if (guard) return guard;
  const theme = await new ThemeStore(env.FEED_DB).getVersion(
    params.themeId ?? "",
    true,
  );
  return theme
    ? jsonResponse({theme})
    : localizedTextError(request, "errors.theme.notFound", 404);
};

export const DELETE: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_SETTINGS_MANAGE, request, env.FEED_DB);
  if (guard) return guard;
  try {
    await new ThemeStore(env.FEED_DB).deleteVersion(
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
