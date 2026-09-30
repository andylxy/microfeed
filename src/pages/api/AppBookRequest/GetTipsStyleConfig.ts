import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {jsonResponse} from "@/server/http";
import {getAppStyleConfig} from "@/server/tcm/reads";

// App 端 `version` 参数保留兼容：样式目录很小，始终返回全量，由 App 侧比对。
export const GET: APIRoute = async () =>
  jsonResponse({styles: await getAppStyleConfig(env.FEED_DB)});
