import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {jsonResponse} from "@/server/http";
import {appEnvelope} from "@/server/tcm/envelope";
import {getAppProjectInfo} from "@/server/tcm/config";

export const GET: APIRoute = async () =>
  jsonResponse(appEnvelope(await getAppProjectInfo(env.FEED_DB)));
