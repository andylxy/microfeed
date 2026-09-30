import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {jsonResponse} from "@/server/http";
import {appEnvelope} from "@/server/tcm/envelope";
import {appReplaceToken} from "@/server/tcm/app-auth";

export const POST: APIRoute = async ({request}) =>
  jsonResponse(appEnvelope(await appReplaceToken(env.FEED_DB, request)));
