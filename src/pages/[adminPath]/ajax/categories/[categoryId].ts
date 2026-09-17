import type {APIRoute} from "astro";

import {jsonResponse, localizedError, serviceError} from "@/server/http";
import type {CategoryDb} from "@/server/feed/extCategory";
import {
  deleteCategoryHandler,
  getCategoryHandler,
  updateCategoryHandler,
} from "@/server/admin/category-handlers";
import {env} from "cloudflare:workers";

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

export const PUT: APIRoute = async ({params, request}) => {
  if (!params.categoryId) {
    return localizedError(request, "errors.category.notFound", 400);
  }
  const parsed = await request.json().catch(() => null);
  try {
    const category = await updateCategoryHandler(
      env.FEED_DB as unknown as CategoryDb,
      params.categoryId,
      parsed,
    );
    return jsonResponse(category);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};

export const DELETE: APIRoute = async ({params, request}) => {
  if (!params.categoryId) {
    return localizedError(request, "errors.category.notFound", 400);
  }
  try {
    await deleteCategoryHandler(
      env.FEED_DB as unknown as CategoryDb,
      params.categoryId,
    );
    return jsonResponse({});
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
