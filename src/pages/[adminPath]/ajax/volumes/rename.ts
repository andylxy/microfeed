import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import {renameVolumeHandler} from "@/server/admin/volume-handlers";
import {requireRbac} from "@/server/rbac/guard";

/** Rename a volume: rewrites the tag on every chapter that carries it. */
export const POST: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, "content:volume:update", request, env.FEED_DB);
  if (guard) return guard;
  const body = await request.json().catch(() => null);
  try {
    return jsonResponse(await renameVolumeHandler(request, env, body));
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
