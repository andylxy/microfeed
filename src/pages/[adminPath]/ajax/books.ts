import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {CategoryDb} from "@/server/feed/extCategory";
import {listBookOptions} from "@/server/feed/extCategory";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

export const GET: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_BOOK_READ, request, env.FEED_DB);
  if (guard) return guard;
  try {
    const books = await listBookOptions(env.FEED_DB as unknown as CategoryDb);
    return jsonResponse(
      {books},
      {headers: {"cache-control": "private, no-store"}},
    );
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
