import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {cachedAppResponse} from "@/server/tcm/app-cache";
import {getAppNav} from "@/server/tcm/reads";

export const GET: APIRoute = async () =>
  cachedAppResponse("nav", () => getAppNav(env.FEED_DB));
