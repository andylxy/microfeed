import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import {assignChaptersHandler} from "@/server/admin/volume-handlers";

/** File chapters under a volume (empty name = back to the unfiled bucket). */
export const POST: APIRoute = async ({request}) => {
  const body = await request.json().catch(() => null);
  try {
    return jsonResponse(await assignChaptersHandler(request, env, body));
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
