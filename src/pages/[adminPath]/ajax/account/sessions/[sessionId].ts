import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {revokeAccountSession} from "@/server/auth/account-admin";
import {localizedTextError} from "@/server/http";

export const DELETE: APIRoute = async ({locals, params, request}) => {
  const userId = locals.authUser?.id;
  const current = locals.authSession?.id;
  const sessionId = params.sessionId;
  if (!userId || !current || !sessionId) return localizedTextError(request, "errors.account.notFound", 404);
  return await revokeAccountSession(env.FEED_DB, userId, current, sessionId)
    ? new Response(null, {status: 204})
    : localizedTextError(request, "errors.account.notFound", 404);
};
