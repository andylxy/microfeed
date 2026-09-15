import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {revokeOAuthConnectionAndTokens} from "@/server/auth/oauth-admin";
import {localizedTextError} from "@/server/http";

export const DELETE: APIRoute = async ({locals, params, request}) => {
  const userId = locals.authUser?.id;
  const clientId = params.clientId;
  const value = params.connectionId;
  if (!userId || !clientId || !value) return localizedTextError(request, "errors.account.notFound", 404);
  const connectionId = value === "legacy" ? null : value;
  return await revokeOAuthConnectionAndTokens(
    env.FEED_DB,
    userId,
    clientId,
    connectionId,
  ) ? new Response(null, {status: 204}) : localizedTextError(request, "errors.account.notFound", 404);
};
