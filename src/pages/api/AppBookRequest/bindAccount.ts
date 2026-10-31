import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {enforceAuthEndpointThrottle} from "@/server/auth/auth-endpoint-throttle";
import {
  appBindAccount,
  bindingEnvelope,
} from "@/server/tcm/app-account-binding";

// 绑定已有账号（ADR-0014 §4.1）。
//
// 必须限流（I15）：这个端点校验**目标账号的口令**，而 `enforceAuthEndpointThrottle`
// 是路径白名单——漏登记就等于开了一个无限次撞库 + 账号枚举的入口（文案统一成
// 「账号或密码错误」，反而方便枚举存在性）。
export const POST: APIRoute = async ({request}) => {
  const throttled = await enforceAuthEndpointThrottle(env.FEED_DB, request);
  if (throttled) return throttled;
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  return bindingEnvelope(
    await appBindAccount(env as never, request, body),
  );
};
