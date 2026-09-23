import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {rotateApiKey} from "@/server/api/api-keys";
import {jsonResponse, localizedError} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

export const POST: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.SYSTEM_API_MANAGE, request, env.FEED_DB);
  if (guard) return guard;
  const id = params.apiKeyId ?? "";
  if (!id) {
    return localizedError(request, "errors.apiKey.invalidId", 400);
  }
  const apiKey = await rotateApiKey(env.FEED_DB, id);
  return apiKey
    ? jsonResponse({apiKey})
    : localizedError(request, "errors.apiKey.notFound", 404);
};
