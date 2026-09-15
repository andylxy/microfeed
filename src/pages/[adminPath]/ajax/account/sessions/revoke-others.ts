import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {revokeOtherAccountSessions} from "@/server/auth/account-admin";
import {jsonResponse, localizedTextError} from "@/server/http";

export const POST: APIRoute = async ({locals, request}) => {
  const userId = locals.authUser?.id;
  const current = locals.authSession?.id;
  if (!userId || !current) return localizedTextError(request, "errors.account.notFound", 404);
  return jsonResponse({revoked: await revokeOtherAccountSessions(
    env.FEED_DB,
    userId,
    current,
  )});
};
