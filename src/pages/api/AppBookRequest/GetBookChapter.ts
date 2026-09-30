import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {jsonResponse} from "@/server/http";
import {appEnvelope} from "@/server/tcm/envelope";
import {getAppBookChapters} from "@/server/tcm/reads";

export const GET: APIRoute = async ({url}) => {
  const bookId = url.searchParams.get("bookId") ?? "";
  if (!bookId) return jsonResponse({error: "missing bookId"}, {status: 400});
  return jsonResponse(appEnvelope(await getAppBookChapters(env.FEED_DB, bookId)), {
    headers: {"cache-control": "public, max-age=300"},
  });
};
