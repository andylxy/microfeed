import {cache, env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {updateApiAccessSettings} from "@/server/api/api-keys";
import {PUBLIC_CACHE_TAGS} from "@/server/cache/public-cache";
import FeedDb from "@/server/feed/FeedDb";
import {jsonResponse, localizedError} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";
import {apiSettingsCommandSchema} from "@/shared/ApiSchemas";

export const POST: APIRoute = async ({locals, request}) => {
  // Site settings are a system-domain write (plan §8.1).
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_SETTINGS_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const parsed = apiSettingsCommandSchema.safeParse(await request.json().catch(
    () => null,
  ));
  if (!parsed.success) {
    return localizedError(request, "errors.api.invalidSettings", 400);
  }
  const settings = await updateApiAccessSettings(env.FEED_DB, parsed.data);
  await new FeedDb(env, request, cache).purgePublicCacheTags([
    PUBLIC_CACHE_TAGS.SITE_FILES,
  ]);
  return jsonResponse({settings});
};
