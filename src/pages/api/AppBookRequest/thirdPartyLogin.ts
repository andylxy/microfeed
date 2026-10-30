import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {jsonResponse} from "@/server/http";
import {appEnvelope} from "@/server/tcm/envelope";
import {appThirdPartyLogin} from "@/server/tcm/app-third-party";
import {enforceAuthEndpointThrottle} from "@/server/auth/auth-endpoint-throttle";

// 第三方登录（ADR-0013，见 AndroidProject-old 仓 docs/adr/0013-qq-third-party-login.md；
// 本期仅 QQ）。复用登录同款限流，补齐暴力破解防护：
// enforceAuthEndpointThrottle 已路径感知（THROTTLED_AUTH_PATHS 含本端点），
// 不改变成功/失败判定与返回体，仅对同一 IP 60s 内 >5 次返回 429。
export const POST: APIRoute = async ({request}) => {
  const throttled = await enforceAuthEndpointThrottle(env.FEED_DB, request);
  if (throttled) return throttled;
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  return jsonResponse(appEnvelope(await appThirdPartyLogin(env, request, body as never)));
};
