import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {rotateApiKey} from "@/server/api/api-keys";
import {jsonResponse, localizedError} from "@/server/http";

export const POST: APIRoute = async ({params, request}) => {
  const id = params.apiKeyId ?? "";
  if (!id) {
    return localizedError(request, "errors.apiKey.invalidId", 400);
  }
  const apiKey = await rotateApiKey(env.FEED_DB, id);
  return apiKey
    ? jsonResponse({apiKey})
    : localizedError(request, "errors.apiKey.notFound", 404);
};
