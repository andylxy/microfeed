import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {jsonResponse} from "@/server/http";
import {appEnvelope} from "@/server/tcm/envelope";
import {getAppChapterContent} from "@/server/tcm/reads";

export const GET: APIRoute = async ({url}) => {
  const chapterId = url.searchParams.get("chapterId") ?? "";
  if (!chapterId) return jsonResponse({error: "missing chapterId"}, {status: 400});
  return jsonResponse(appEnvelope(await getAppChapterContent(env.FEED_DB, chapterId)), {
    headers: {"cache-control": "public, max-age=300"},
  });
};
