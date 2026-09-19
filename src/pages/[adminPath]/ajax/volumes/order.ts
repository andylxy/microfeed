import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import {setVolumeOrderHandler} from "@/server/admin/volume-handlers";

/** Give volumes an explicit position (stored as a tag on their chapters). */
export const POST: APIRoute = async ({request}) => {
  const body = await request.json().catch(() => null);
  try {
    return jsonResponse(await setVolumeOrderHandler(request, env, body));
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
