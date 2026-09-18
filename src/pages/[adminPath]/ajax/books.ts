import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {CategoryDb} from "@/server/feed/extCategory";
import {listBookOptions} from "@/server/feed/extCategory";

export const GET: APIRoute = async () => {
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
