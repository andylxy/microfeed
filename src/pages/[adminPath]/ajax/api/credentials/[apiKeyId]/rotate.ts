import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {rotateApiKeyForUser} from "@/server/api/api-keys";
import {jsonResponse, localizedError} from "@/server/http";

// Rotates a credential the current user owns. The old secret is invalidated and a
// new plaintext secret is returned exactly once.
export const POST: APIRoute = async ({locals, params, request}) => {
  const userId = locals.authUser?.id;
  const id = params.apiKeyId;
  if (!userId || !id) {
    return localizedError(request, "errors.account.notFound", 401);
  }
  const apiKey = await rotateApiKeyForUser(env.FEED_DB, userId, id);
  if (!apiKey) return localizedError(request, "errors.apiKey.notFound", 404);
  return jsonResponse({apiKey});
};
