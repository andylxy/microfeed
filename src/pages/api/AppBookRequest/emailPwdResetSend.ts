import type {APIRoute} from "astro";
import {cache, env} from "cloudflare:workers";

import FeedDb from "@/server/feed/FeedDb";
import {jsonResponse, readStringField} from "@/server/http";
import {appEnvelope} from "@/server/tcm/envelope";
import {
  EMAIL_PATTERN,
  normalizeEmail,
  readJsonBody,
} from "@/server/app/email-register/form";
import {
  PWD_RESET_PURPOSE,
  findEmailAccount,
  isPlaceholderEmail,
} from "@/server/app/email-pwd-reset/identity";
import {pwdResetGate, readMethods} from "@/server/app/email-pwd-reset/gate";
import {clientAddress} from "@/server/auth/client-address";
import {verifyCaptcha} from "@/server/tcm/captcha";
import {
  cleanupCaptchaNonces,
  consumeCaptchaOnce,
} from "@/server/tcm/captcha-nonce";
import {
  OTP_TTL_MS,
  generateEmailOtp,
  hashOtp,
  rateLimitSend,
  storeOtp,
} from "@/server/tcm/email-otp";
import {renderOtpEmail} from "@/server/mail/email-templates";
import {sendEmailOtp} from "@/server/mail/resend";
import {readMailSettingsConfig, resolveFromAddress} from "@/server/mail/mail-config";

/**
 * 忘记密码：发码（ADR-0015 D6）。匿名端点，**只接受邮箱**。
 *
 * ## 顺序即决策
 *
 * 开关门 → 邮箱格式 → **图形验证码（一次性）** → **限流** → 存在性判定 → 发码。
 *
 * 存在性判定必须排在限流之后：注册链路的 `emailCodeGet` 把「已注册」检查放在
 * 限流之前，命中分支不写 OTP 行、不占任何配额，等于一个免费的存在性 oracle
 * （ADR-0015 F1）。这里不能复制那个顺序。
 *
 * ## 图形验证码为什么要"消费"
 *
 * `verifyCaptcha` 是无状态的（只验签），同一张码 120s 内可无限复用。不记账的话，
 * 解一次图就能打满 IP 窗口，门控成本被高估 40 倍（F2）。`consumeCaptchaOnce`
 * 用 `INSERT OR IGNORE` 的 changes 判首次使用，与 `consumeOtp` 同一套并发语义。
 *
 * 消费发生在**发信之前**：发信失败时这张图已被烧掉，用户须刷新一次图。这是有意的
 * 取舍——宁可多刷一张图，也不允许一张图打多个请求。
 */

const OTP_EXPIRE_MINUTES = Math.round(OTP_TTL_MS / 60_000);

export const POST: APIRoute = async ({request}) => {
  const body = await readJsonBody(request);
  const db = new FeedDb(env, request, cache);

  const methods = await readMethods(db);
  const gate = pwdResetGate(methods);
  if (gate) return gate;

  const email = normalizeEmail(body);
  if (!EMAIL_PATTERN.test(email)) {
    return jsonResponse(appEnvelope("邮箱格式不正确"));
  }

  // 图形验证码：与登录页同一套（无状态 HMAC），但这里必须一次性。
  if (methods.captchaEnabled) {
    const verificationCode = readStringField(body, "verificationCode").trim();
    const reqNo = readStringField(body, "uuid").trim();
    if (!verificationCode || !reqNo) {
      return jsonResponse(appEnvelope("请输入图形验证码"));
    }
    if (!await verifyCaptcha(env.BETTER_AUTH_SECRET, verificationCode, reqNo)) {
      return jsonResponse(appEnvelope("验证码错误或已过期"));
    }
    if (!await consumeCaptchaOnce(env.FEED_DB, reqNo)) {
      return jsonResponse(appEnvelope("验证码已使用，请刷新后重试"));
    }
    await cleanupCaptchaNonces(env.FEED_DB);
  }

  const limit = await rateLimitSend(
    env.FEED_DB,
    email,
    PWD_RESET_PURPOSE,
    clientAddress(request),
  );
  if (!limit.ok) {
    const message = limit.reason === "dailyLimit"
      ? "今日发送次数已达上限"
      : "操作过于频繁，请稍后再试";
    return jsonResponse(appEnvelope(message));
  }

  // 存在性判定：只在过了验证码与限流之后（F1）。
  const account = await findEmailAccount(env.FEED_DB, email);
  if (!account) {
    return jsonResponse(appEnvelope("该邮箱未注册"));
  }
  if (isPlaceholderEmail(account.email)) {
    return jsonResponse(
      appEnvelope("该账号未绑定邮箱，请先在「个人资料」补充邮箱后再找回"),
    );
  }

  const code = generateEmailOtp();
  const codeHash = await hashOtp(code, env.BETTER_AUTH_SECRET);
  await storeOtp(env.FEED_DB, email, PWD_RESET_PURPOSE, codeHash);

  const settings = await readMailSettingsConfig(db);
  const {subject, html} = renderOtpEmail(settings, code, OTP_EXPIRE_MINUTES);
  const fromAddress = resolveFromAddress(settings, env.RESEND_FROM);

  try {
    await sendEmailOtp(env, email, subject, html, fromAddress);
  } catch (error) {
    console.error(
      `[emailPwdResetSend] send failed: ${error instanceof Error ? error.name : "unknown"}`,
    );
    return jsonResponse(appEnvelope("验证码发送失败，请稍后重试"));
  }

  return jsonResponse(appEnvelope({}));
};
