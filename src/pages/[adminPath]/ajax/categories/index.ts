import {cache, env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import {
  PUBLIC_CACHE_TAGS,
  purgePublicCache,
} from "@/server/cache/public-cache";
import type {CategoryDb} from "@/server/feed/extCategory";
import {
  createCategoryHandler,
  listCategoriesHandler,
} from "@/server/admin/category-handlers";

export const GET: APIRoute = async () => {
  try {
    const items = await listCategoriesHandler(
      env.FEED_DB as unknown as CategoryDb,
    );
    return jsonResponse(
      {items},
      {headers: {"cache-control": "private, no-store"}},
    );
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};

export const POST: APIRoute = async ({request}) => {
  const parsed = await request.json().catch(() => null);
  try {
    const category = await createCategoryHandler(
      env.FEED_DB as unknown as CategoryDb,
      parsed,
    );
    // The header nav and the category pages are cached, so a new category has to
    // invalidate them or it stays invisible for the whole cache window.
    await purgePublicCache([PUBLIC_CACHE_TAGS.PUBLIC], cache);
    return jsonResponse(category, {status: 201});
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
