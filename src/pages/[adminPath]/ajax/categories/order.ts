import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import {
  PUBLIC_CACHE_TAGS,
  purgePublicCache,
} from "@/server/cache/public-cache";
import type {CategoryDb} from "@/server/feed/extCategory";
import {reorderCategoriesHandler} from "@/server/admin/category-handlers";
import {cache, env} from "cloudflare:workers";

export const POST: APIRoute = async ({request}) => {
  const parsed = await request.json().catch(() => null);
  try {
    await reorderCategoriesHandler(
      env.FEED_DB as unknown as CategoryDb,
      parsed,
    );
    await purgePublicCache([PUBLIC_CACHE_TAGS.PUBLIC], cache);
    return jsonResponse({});
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
