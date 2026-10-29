import type {APIRoute} from "astro";
import {cache, env} from "cloudflare:workers";

import FeedDb from "@/server/feed/FeedDb";
import {jsonResponse, readStringField} from "@/server/http";
import {appEnvelope} from "@/server/tcm/envelope";
import {emailRegisterGate} from "@/server/app/email-register/gate";
import {
  EMAIL_PATTERN,
  normalizeEmail,
  otpFailureMessage,
  otpPurpose,
  readJsonBody,
} from "@/server/app/email-register/form";
import {verifyOtp} from "@/server/tcm/email-otp";

/**
 * 邮箱验证码校验（邮箱 + 验证码注册 §3.4）。匿名端点。
 *
 * 只做**预校验**：告诉 App「这个码现在对不对」，让用户在提交前就看到结果。
 * 校验通过**不删行**，验证码的消费权属于 `emailRegister`——那边还会查邮箱是否
 * 已被占用，占用时直接把码留着，用户改用登录即可，不必重新收码。
 *
 * 因此本端点可以安全地重复调用：同一个码在校验通过后仍然有效，直到注册端点
 * 消费它或者它过期。
 */
export const POST: APIRoute = async ({request}) => {
  const body = await readJsonBody(request);
  const db = new FeedDb(env, request, cache);

  const gate = await emailRegisterGate(db);
  if (gate) return gate;

  const email = normalizeEmail(body);
  if (!EMAIL_PATTERN.test(email)) {
    return jsonResponse(appEnvelope("邮箱格式不正确"));
  }

  const code = readStringField(body, "code").trim();
  if (!code) {
    return jsonResponse(appEnvelope("验证码错误"));
  }

  const result = await verifyOtp(
    env.FEED_DB,
    email,
    otpPurpose(body),
    code,
    env.BETTER_AUTH_SECRET,
  );
  if (!result.ok) {
    return jsonResponse(appEnvelope(otpFailureMessage(result.reason)));
  }

  return jsonResponse(appEnvelope({ok: true}));
};
