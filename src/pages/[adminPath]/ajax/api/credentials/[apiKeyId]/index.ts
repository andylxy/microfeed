import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {
  ApiKeyNameConflictError,
  renameApiKeyForUser,
  revokeApiKeyForUser,
} from "@/server/api/api-keys";
import {jsonResponse, localizedError} from "@/server/http";

// Revokes a credential the current user owns (key + owner row are removed).
export const DELETE: APIRoute = async ({locals, params, request}) => {
  const userId = locals.authUser?.id;
  const id = params.apiKeyId;
  if (!userId || !id) {
    return localizedError(request, "errors.account.notFound", 401);
  }
  const ok = await revokeApiKeyForUser(env.FEED_DB, userId, id);
  if (!ok) return localizedError(request, "errors.apiKey.notFound", 404);
  return jsonResponse({ok: true});
};

// Renames a credential the current user owns.
export const PATCH: APIRoute = async ({locals, params, request}) => {
  const userId = locals.authUser?.id;
  const id = params.apiKeyId;
  if (!userId || !id) {
    return localizedError(request, "errors.account.notFound", 401);
  }
  const body = (await request.json().catch(() => null)) as {name?: unknown} | null;
  const rawName = body?.name;
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) {
    return localizedError(request, "errors.apiCredential.invalidName", 400);
  }
  try {
    const apiKey = await renameApiKeyForUser(env.FEED_DB, userId, id, name);
    if (!apiKey) return localizedError(request, "errors.apiKey.notFound", 404);
    return jsonResponse({apiKey});
  } catch (error) {
    if (error instanceof ApiKeyNameConflictError) {
      return jsonResponse({error: error.message}, {status: 409});
    }
    throw error;
  }
};
