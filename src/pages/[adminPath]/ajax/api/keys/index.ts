import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {
  ApiKeyNameConflictError,
  createApiKey,
  readApiAccessSettings,
} from "@/server/api/api-keys";
import {jsonResponse, localizedError} from "@/server/http";
import {createApiKeyCommandSchema} from "@/shared/ApiSchemas";

export const POST: APIRoute = async ({request}) => {
  const parsed = createApiKeyCommandSchema.safeParse(await request.json().catch(
    () => null,
  ));
  if (!parsed.success) {
    return localizedError(request, "errors.apiKey.nameUnique", 400);
  }
  const settings = parsed.data.settings ??
    await readApiAccessSettings(env.FEED_DB);
  if (!settings.enabled) {
    return localizedError(request, "errors.apiKey.enableFirst", 409);
  }
  try {
    const apiKey = await createApiKey(env.FEED_DB, {
      name: parsed.data.name,
      scopes: parsed.data.scopes,
      settings: parsed.data.settings,
    });
    return jsonResponse({apiKey, settings}, {status: 201});
  } catch (error) {
    if (error instanceof ApiKeyNameConflictError) {
      return jsonResponse({error: error.message}, {status: 409});
    }
    throw error;
  }
};
