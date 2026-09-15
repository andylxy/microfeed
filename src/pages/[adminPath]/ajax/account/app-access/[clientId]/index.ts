import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {revokeOAuthApplicationAccess} from "@/server/auth/oauth-admin";
import {localizedTextError} from "@/server/http";

export const DELETE: APIRoute = async ({locals, params, request}) => {
  const userId = locals.authUser?.id;
  const clientId = params.clientId;
  if (!userId || !clientId) return localizedTextError(request, "errors.account.notFound", 404);
  return await revokeOAuthApplicationAccess(env.FEED_DB, userId, clientId)
    ? new Response(null, {status: 204})
    : localizedTextError(request, "errors.account.notFound", 404);
};
