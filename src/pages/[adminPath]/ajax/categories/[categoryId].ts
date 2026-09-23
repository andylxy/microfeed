import type {APIRoute} from "astro";

import {jsonResponse, localizedError, serviceError} from "@/server/http";
import {
  PUBLIC_CACHE_TAGS,
  purgePublicCache,
} from "@/server/cache/public-cache";
import type {CategoryDb} from "@/server/feed/extCategory";
import {
  deleteCategoryHandler,
  getCategoryHandler,
  updateCategoryHandler,
} from "@/server/admin/category-handlers";
import {cache, env} from "cloudflare:workers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

export const GET: APIRoute = async ({params, request}) => {
  if (!params.categoryId) {
    return localizedError(request, "errors.category.notFound", 400);
  }
  try {
    const category = await getCategoryHandler(
      env.FEED_DB as unknown as CategoryDb,
      params.categoryId,
    );
    return jsonResponse(category);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};

export const PUT: APIRoute = async ({locals, params, request}) => {
  if (!params.categoryId) {
    return localizedError(request, "errors.category.notFound", 400);
  }
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_CATEGORY_UPDATE, request, env.FEED_DB);
  if (guard) return guard;
  const parsed = await request.json().catch(() => null);
  try {
    const category = await updateCategoryHandler(
      env.FEED_DB as unknown as CategoryDb,
      params.categoryId,
      parsed,
    );
    await purgePublicCache([PUBLIC_CACHE_TAGS.PUBLIC], cache);
    return jsonResponse(category);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};

export const DELETE: APIRoute = async ({locals, params, request}) => {
  if (!params.categoryId) {
    return localizedError(request, "errors.category.notFound", 400);
  }
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_CATEGORY_DELETE, request, env.FEED_DB);
  if (guard) return guard;
  try {
    await deleteCategoryHandler(
      env.FEED_DB as unknown as CategoryDb,
      params.categoryId,
    );
    await purgePublicCache([PUBLIC_CACHE_TAGS.PUBLIC], cache);
    return jsonResponse({});
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
