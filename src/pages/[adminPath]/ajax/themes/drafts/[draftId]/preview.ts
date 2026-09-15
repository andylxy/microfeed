import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import ThemeStore from "@/server/themes/ThemeStore";
import {themePreviewResponse} from "@/server/themes/ThemePreview";
import {localizedError} from "@/server/http";

export const GET: APIRoute = async ({params, request}) => {
  const draft = await new ThemeStore(env.FEED_DB).getDraft(params.draftId ?? "");
  return draft
    ? themePreviewResponse(env, request, draft)
    : localizedError(request, "errors.theme.draftNotFound", 404);
};
