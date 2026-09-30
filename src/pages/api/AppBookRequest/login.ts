import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {jsonResponse} from "@/server/http";
import {appEnvelope} from "@/server/tcm/envelope";
import {appLogin} from "@/server/tcm/app-auth";

// 旧后端 login 为 POST + LoginInfo（UserName/Password），失败时 HTTP 200 + 字符串（信封内）。
export const POST: APIRoute = async ({request}) => {
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  return jsonResponse(appEnvelope(await appLogin(env, request, body as never)));
};
