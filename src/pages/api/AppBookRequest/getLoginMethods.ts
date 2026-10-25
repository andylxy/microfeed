import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import FeedDb from "@/server/feed/FeedDb";
import {readLoginMethodsConfigCached} from "@/server/app/login/config";
import {jsonResponse} from "@/server/http";
import {appEnvelope} from "@/server/tcm/envelope";

// 登录页配置（ADR-0050）：App 进登录页时拉一次，登录方式与验证码行的显隐
// 全部按本响应渲染（`getPicCaptcha` 只发码，不过问显隐——ADR-0050 D4）。
// read-through 缓存（ADR-0050 D3）：常态 0 D1 行读，后台保存路径清缓存。
// `updatedBy` 不出端点：操作者身份是后台审计信息，App 无需知晓。
export const GET: APIRoute = async ({request}) => {
  const config = await readLoginMethodsConfigCached(new FeedDb(env, request));
  return jsonResponse(appEnvelope({
    loginEnabled: config.loginEnabled,
    accountPasswordEnabled: config.accountPasswordEnabled,
    smsEnabled: config.smsEnabled,
    wechatEnabled: config.wechatEnabled,
    qqEnabled: config.qqEnabled,
    captchaEnabled: config.captchaEnabled,
    updatedAtMs: config.updatedAtMs,
  }));
};
