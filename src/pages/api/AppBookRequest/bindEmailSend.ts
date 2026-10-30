import type {APIRoute} from "astro";
import {cache, env} from "cloudflare:workers";

import FeedDb from "@/server/feed/FeedDb";
import {jsonResponse} from "@/server/http";
import {appEnvelope} from "@/server/tcm/envelope";
import {
  EMAIL_PATTERN,
  normalizeEmail,
  readJsonBody,
} from "@/server/app/email-register/form";
import {
  BIND_EMAIL_PURPOSE,
  emailTakenByOther,
  isPlaceholderEmail,
} from "@/server/app/email-pwd-reset/identity";
import {bindEmailGate, readMethods} from "@/server/app/email-pwd-reset/gate";
import {
  consumeBindQuota,
  isResponse,
  requireAppUser,
  verifyReauth,
} from "@/server/app/bind-email/guard";
import {clientAddress} from "@/server/auth/client-address";
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
 * 补充邮箱：发码到**新邮箱**（ADR-0015 D21）。
 *
 * 顺序：开关门 → 登录态 → **再认证**（F29）→ 新邮箱格式 → **非占位域**（F28）
 * → 未被占用 → 每账号配额（F24）→ 目标邮箱限流 → 发码。
 *
 * 再认证放在最前：它是本端点最贵的检查（一次腾讯调用），也是最该先失败的一步
 * ——令牌被盗时，攻击者不该有机会触发任何后续动作（包括给目标邮箱发信）。
 */
const OTP_EXPIRE_MINUTES = Math.round(OTP_TTL_MS / 60_000);

export const POST: APIRoute = async ({request}) => {
  const body = await readJsonBody(request);
  const db = new FeedDb(env, request, cache);

  const gate = bindEmailGate(await readMethods(db));
  if (gate) return gate;

  const user = await requireAppUser(env.FEED_DB, request);
  if (isResponse(user)) return user;

  const reauth = await verifyReauth(env, request, user.userId, body);
  if (reauth) return reauth;

  const email = normalizeEmail(body);
  if (!EMAIL_PATTERN.test(email)) {
    return jsonResponse(appEnvelope("邮箱格式不正确"));
  }
  if (isPlaceholderEmail(email)) {
    return jsonResponse(appEnvelope("该邮箱不可用"));
  }
  if (await emailTakenByOther(env.FEED_DB, email, user.userId)) {
    return jsonResponse(appEnvelope("该邮箱已被其他账号使用"));
  }

  if (!await consumeBindQuota(env.FEED_DB, user.userId)) {
    return jsonResponse(appEnvelope("今日发送次数已达上限"));
  }

  const limit = await rateLimitSend(
    env.FEED_DB,
    email,
    BIND_EMAIL_PURPOSE,
    clientAddress(request),
  );
  if (!limit.ok) {
    const message = limit.reason === "dailyLimit"
      ? "今日发送次数已达上限"
      : "操作过于频繁，请稍后再试";
    return jsonResponse(appEnvelope(message));
  }

  const code = generateEmailOtp();
  const codeHash = await hashOtp(code, env.BETTER_AUTH_SECRET);
  await storeOtp(env.FEED_DB, email, BIND_EMAIL_PURPOSE, codeHash);

  const settings = await readMailSettingsConfig(db);
  const {subject, html} = renderOtpEmail(settings, code, OTP_EXPIRE_MINUTES);
  const fromAddress = resolveFromAddress(settings, env.RESEND_FROM);

  try {
    await sendEmailOtp(env, email, subject, html, fromAddress);
  } catch (error) {
    console.error(
      `[bindEmailSend] send failed: ${error instanceof Error ? error.name : "unknown"}`,
    );
    return jsonResponse(appEnvelope("验证码发送失败，请稍后重试"));
  }

  return jsonResponse(appEnvelope({}));
};
