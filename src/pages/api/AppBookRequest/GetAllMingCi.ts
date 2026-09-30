import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {jsonResponse} from "@/server/http";
import {appEnvelope} from "@/server/tcm/envelope";
import {getAppAllTerms} from "@/server/tcm/reads";

export const GET: APIRoute = async () =>
  jsonResponse(appEnvelope(await getAppAllTerms(env.FEED_DB)), {
    headers: {"cache-control": "public, max-age=300"},
  });
