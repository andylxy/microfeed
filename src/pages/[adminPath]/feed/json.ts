import type {APIRoute} from "astro";

import {jsonResponse, localizedTextError} from "@/server/http";

export const GET: APIRoute = ({locals, request}) => {
  if (!locals.feedContent) {
    return localizedTextError(request, "errors.general.feedContextUnavailable", 500);
  }
  return jsonResponse(locals.feedContent);
};
