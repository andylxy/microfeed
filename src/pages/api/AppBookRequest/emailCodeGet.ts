import type {APIRoute} from "astro";
import {cache, env} from "cloudflare:workers";

import FeedDb from "@/server/feed/FeedDb";
import {jsonResponse} from "@/server/http";
import {appEnvelope} from "@/server/tcm/envelope";
import {emailRegisterGate} from "@/server/app/email-register/gate";
import {clientAddress} from "@/server/auth/client-address";
import {
  EMAIL_PATTERN,
  normalizeEmail,
  otpPurpose,
  readJsonBody,
} from "@/server/app/email-register/form";
import {
  OTP_TTL_MS,
  generateEmailOtp,
  hashOtp,
  rateLimitSend,
  storeOtp,
} from "@/server/tcm/email-otp";
import {renderOtpEmail} from "@/server/mail/email-templates";
import {sendEmailOtp} from "@/server/mail/resend";
import {
  readMailSettingsConfig,
  resolveFromAddress,
} from "@/server/mail/mail-config";

/**
 * 邮箱验证码下发（邮箱 + 验证码注册 §3.3）。匿名端点——此时用户还没有账号。
 *
 * 防刷三道，顺序有意义：先开关（停机手段）→ 邮箱格式（挡脏数据）→ 限流
 * （挡重发与爆破）。发码成功后 OTP 行已落库，即便发信失败也返回失败文案——
 * 不删行，避免「扣了当日额度却没发信」。
 *
 * 注意：本端点**不做图形验证码**（ADR 修订，移动端不弹码）。发码的防脚本
 * 成本由限流承担，与登录页 `getPicCaptcha` 的强制验码是两条独立链路。
 *
 * 失败一律 `appEnvelope(文案字符串)`：旧后端风格（HTTP 200 + data 为字符串），
 * App 的 RequestHandler 按 data 是否为字符串判定成败。
 */

const OTP_EXPIRE_MINUTES = Math.round(OTP_TTL_MS / 60_000);

export const POST: APIRoute = async ({request}) => {
  const body = await readJsonBody(request);
  const db = new FeedDb(env, request, cache);

  // 1. 开关门：关掉时既不发码也不建号，已注册账号登录不受影响。
  const gate = await emailRegisterGate(db);
  if (gate) return gate;

  // 2. 邮箱格式
  const email = normalizeEmail(body);
  if (!EMAIL_PATTERN.test(email)) {
    return jsonResponse(appEnvelope("邮箱格式不正确"));
  }
  const purpose = otpPurpose(body);

  // 3. 限流：重发间隔 / 当日上限 / IP 窗口
  const limit = await rateLimitSend(
    env.FEED_DB,
    email,
    purpose,
    clientAddress(request),
  );
  if (!limit.ok) {
    const message =
      limit.reason === "dailyLimit"
        ? "今日发送次数已达上限"
        : "操作过于频繁，请稍后再试";
    return jsonResponse(appEnvelope(message));
  }

  // 4. 生成并存储 OTP（明文只在这一刻存在，落库的是哈希）。走真实随机码，
  // 用户自行收邮件输入，服务端 `checkout` / `register` 校验。
  const code = generateEmailOtp();
  const codeHash = await hashOtp(code, env.BETTER_AUTH_SECRET);
  await storeOtp(env.FEED_DB, email, purpose, codeHash);

  // 5. 发信：模板来自后台「邮件设置」，未配置回落出厂模板
  const settings = await readMailSettingsConfig(db);
  const {subject, html} = renderOtpEmail(settings, code, OTP_EXPIRE_MINUTES);
  const fromAddress = resolveFromAddress(settings, env.RESEND_FROM);

  try {
    await sendEmailOtp(env, email, subject, html, fromAddress);
  } catch {
    // 发信失败不回滚 OTP 行：重发会命中 60s 间隔，用户须稍后再试。
    // 不把 Resend 的原始错误透出去（可能含账号/域名信息）。
    return jsonResponse(appEnvelope("验证码发送失败，请稍后重试"));
  }

  return jsonResponse(appEnvelope({}));
};
