import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import {assignChaptersHandler} from "@/server/admin/volume-handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/** File chapters under a volume (empty name = back to the unfiled bucket). */
export const POST: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_VOLUME_UPDATE, request, env.FEED_DB);
  if (guard) return guard;
  const body = await request.json().catch(() => null);
  try {
    return jsonResponse(await assignChaptersHandler(request, env, body));
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
