import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {cachedAppResponse} from "@/server/tcm/app-cache";
import {getAppYaoAliases} from "@/server/tcm/reads";

export const GET: APIRoute = async () =>
  cachedAppResponse("yao-aliases", () => getAppYaoAliases(env.FEED_DB));
