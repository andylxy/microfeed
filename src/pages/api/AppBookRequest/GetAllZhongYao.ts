import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {cachedAppResponse} from "@/server/tcm/app-cache";
import {getAppAllYao} from "@/server/tcm/reads";

export const GET: APIRoute = async () =>
  cachedAppResponse("zhongyao", () => getAppAllYao(env.FEED_DB));
