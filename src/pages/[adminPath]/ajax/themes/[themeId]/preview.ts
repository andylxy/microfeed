import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import ThemeStore from "@/server/themes/ThemeStore";
import {themePreviewResponse} from "@/server/themes/ThemePreview";
import {localizedError} from "@/server/http";

export const GET: APIRoute = async ({params, request}) => {
  const theme = await new ThemeStore(env.FEED_DB).getVersion(
    params.themeId ?? "",
  );
  return theme
    ? themePreviewResponse(env, request, theme)
    : localizedError(request, "errors.theme.notFound", 404);
};
