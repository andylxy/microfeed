import type {APIRoute} from "astro";
import {cache, env} from "cloudflare:workers";

import FeedDb from "@/server/feed/FeedDb";
import {jsonResponse, readStringField} from "@/server/http";
import {appEnvelope} from "@/server/tcm/envelope";
import {
  EMAIL_PATTERN,
  normalizeEmail,
  otpFailureMessage,
  readJsonBody,
} from "@/server/app/email-register/form";
import {PWD_RESET_PURPOSE} from "@/server/app/email-pwd-reset/identity";
import {pwdResetGate, readMethods} from "@/server/app/email-pwd-reset/gate";
import {verifyOtp} from "@/server/tcm/email-otp";

/**
 * 忘记密码：验证码预校验（ADR-0015 D6）。匿名端点。
 *
 * 与注册的 `emailCodeCheckout` 同形：只校验、**不消费**，让用户在提交新口令前
 * 就看到「码对不对」。消费权属于 `emailPwdResetCommit`——那边还要落口令、清会话，
 * 失败时不该把用户的码白白烧掉。
 *
 * 本端点不做存在性判定：能走到这里说明发码已经通过（码只对已注册且非占位域的
 * 邮箱发出），多查一次只是多一个 oracle。
 */
export const POST: APIRoute = async ({request}) => {
  const body = await readJsonBody(request);
  const db = new FeedDb(env, request, cache);

  const gate = pwdResetGate(await readMethods(db));
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
    PWD_RESET_PURPOSE,
    code,
    env.BETTER_AUTH_SECRET,
  );
  if (!result.ok) {
    return jsonResponse(appEnvelope(otpFailureMessage(result.reason)));
  }

  return jsonResponse(appEnvelope({ok: true}));
};
