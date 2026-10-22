import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {jsonResponse} from "@/server/http";
import {appEnvelope} from "@/server/tcm/envelope";
import {getAppBookFang, tierFromAppMember, type AppNavTier} from "@/server/tcm/reads";

export const GET: APIRoute = async ({locals, url}) => {
  const bookId = url.searchParams.get("bookId") ?? "";
  if (!bookId) return jsonResponse({error: "missing bookId"}, {status: 400});
  const tier: AppNavTier = tierFromAppMember(locals.appMember);
  return jsonResponse(appEnvelope(await getAppBookFang(env.FEED_DB, bookId, tier)), {
    headers: {"cache-control": "public, max-age=300"},
  });
};
