import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {
  ApiKeyNameConflictError,
  renameApiKey,
  revokeApiKey,
} from "@/server/api/api-keys";
import {jsonResponse, localizedError} from "@/server/http";
import {renameApiKeyCommandSchema} from "@/shared/ApiSchemas";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

export const PATCH: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.SYSTEM_API_MANAGE, request, env.FEED_DB);
  if (guard) return guard;
  const id = params.apiKeyId ?? "";
  const parsed = renameApiKeyCommandSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!id || !parsed.success) {
    return localizedError(request, "errors.apiKey.nameRequired", 400);
  }
  try {
    const apiKey = await renameApiKey(env.FEED_DB, id, parsed.data.name);
    return apiKey
      ? jsonResponse({apiKey})
      : localizedError(request, "errors.apiKey.notFound", 404);
  } catch (error) {
    if (error instanceof ApiKeyNameConflictError) {
      return jsonResponse({error: error.message}, {status: 409});
    }
    throw error;
  }
};

export const DELETE: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.SYSTEM_API_MANAGE, request, env.FEED_DB);
  if (guard) return guard;
  const id = params.apiKeyId ?? "";
  if (!id) {
    return localizedError(request, "errors.apiKey.invalidId", 400);
  }
  return await revokeApiKey(env.FEED_DB, id)
    ? jsonResponse({})
    : localizedError(request, "errors.apiKey.notFound", 404);
};
