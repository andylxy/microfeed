import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {jsonResponse, localizedTextError} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

export const GET: APIRoute = async ({locals, request}) => {
  // B26: this is the dashboard's bootstrap document (channels, items,
  // settings). The chapter-read code is the resource read it serves; the
  // default `readonly` role holds it, so every legitimate dashboard keeps
  // working while anonymous or code-less sessions get 403.
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_CHAPTER_READ, request, env.FEED_DB);
  if (guard) return guard;
  if (!locals.feedContent) {
    return localizedTextError(request, "errors.general.feedContextUnavailable", 500);
  }
  return jsonResponse(locals.feedContent);
};
