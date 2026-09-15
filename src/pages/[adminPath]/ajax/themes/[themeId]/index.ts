import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {appErrorResponse, jsonResponse, localizedTextError} from "@/server/http";
import {AppError} from "@/shared/errors";
import {mediaBucket} from "@/server/media/storage";
import ThemeStore from "@/server/themes/ThemeStore";

export const GET: APIRoute = async ({params, request}) => {
  const theme = await new ThemeStore(env.FEED_DB).getVersion(
    params.themeId ?? "",
    true,
  );
  return theme
    ? jsonResponse({theme})
    : localizedTextError(request, "errors.theme.notFound", 404);
};

export const DELETE: APIRoute = async ({params, request}) => {
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
