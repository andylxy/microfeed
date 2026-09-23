import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import ThemeStore from "@/server/themes/ThemeStore";
import {themePreviewResponse} from "@/server/themes/ThemePreview";
import {localizedError} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

export const GET: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_SETTINGS_MANAGE, request, env.FEED_DB);
  if (guard) return guard;
  const draft = await new ThemeStore(env.FEED_DB).getDraft(params.draftId ?? "");
  return draft
    ? themePreviewResponse(env, request, draft)
    : localizedError(request, "errors.theme.draftNotFound", 404);
};
