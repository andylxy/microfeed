import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import {reorderChaptersHandler} from "@/server/admin/volume-handlers";

/** Rewrite `chapterNo` — moves chapters inside a volume and across volumes. */
export const POST: APIRoute = async ({request}) => {
  const body = await request.json().catch(() => null);
  try {
    return jsonResponse(await reorderChaptersHandler(request, env, body));
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
