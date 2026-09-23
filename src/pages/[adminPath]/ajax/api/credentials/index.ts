import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {
  countApiKeysForUser,
  createApiKey,
  listApiKeysForUser,
  readApiAccessSettings,
} from "@/server/api/api-keys";
import {MAX_API_CREDENTIALS_PER_USER} from "@/shared/Api";
import {jsonResponse, localizedError} from "@/server/http";

// Lists only the credentials owned by the current user.
export const GET: APIRoute = async ({locals, request}) => {
  const userId = locals.authUser?.id;
  if (!userId) return localizedError(request, "errors.account.notFound", 401);
  const apiKeys = await listApiKeysForUser(env.FEED_DB, userId);
  return jsonResponse({apiKeys});
};

// Creates a credential owned by the current user. The plaintext secret is
// returned exactly once in the response; only its hash is stored.
export const POST: APIRoute = async ({locals, request}) => {
  const userId = locals.authUser?.id;
  if (!userId) return localizedError(request, "errors.account.notFound", 401);

  const body = (await request.json().catch(() => null)) as {name?: unknown} | null;
  const rawName = body?.name;
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) {
    return localizedError(request, "errors.apiCredential.invalidName", 400);
  }

  const settings = await readApiAccessSettings(env.FEED_DB);
  if (!settings.enabled) {
    return localizedError(request, "errors.apiKey.enableFirst", 409);
  }
  const count = await countApiKeysForUser(env.FEED_DB, userId);
  if (count >= MAX_API_CREDENTIALS_PER_USER) {
    return localizedError(
      request,
      "errors.apiCredential.limitReached",
      409,
      {count: String(MAX_API_CREDENTIALS_PER_USER)},
    );
  }

  const apiKey = await createApiKey(env.FEED_DB, {name, ownerUserId: userId});
  return jsonResponse({apiKey, settings}, {status: 201});
};
