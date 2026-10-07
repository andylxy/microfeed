import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {jsonResponse} from "@/server/http";
import {appEnvelope} from "@/server/tcm/envelope";
import {appLogin} from "@/server/tcm/app-auth";
import {enforceAuthEndpointThrottle} from "@/server/auth/auth-endpoint-throttle";

// 旧后端 login 为 POST + LoginInfo（UserName/Password），失败时 HTTP 200 + 字符串（信封内）。
// 工单 01（ADR-0011 D1）：复用后台登录同款限流，补齐移动端登录的暴力破解防护。
// enforceAuthEndpointThrottle 已路径感知（THROTTLED_AUTH_PATHS 含 /api/AppBookRequest/login），
// 不改变登录成功/失败判定与返回体，仅对同一 IP 60s 内 >5 次登录返回 429。
export const POST: APIRoute = async ({request}) => {
  const throttled = await enforceAuthEndpointThrottle(env.FEED_DB, request);
  if (throttled) return throttled;
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  return jsonResponse(appEnvelope(await appLogin(env, request, body as never)));
};
