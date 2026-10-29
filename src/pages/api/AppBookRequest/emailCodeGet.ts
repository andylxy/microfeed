import type {APIRoute} from "astro";
import {cache, env} from "cloudflare:workers";

import FeedDb from "@/server/feed/FeedDb";
import {jsonResponse} from "@/server/http";
import {appEnvelope} from "@/server/tcm/envelope";
import {emailRegisterGate} from "@/server/app/email-register/gate";
import {emailAlreadyRegistered} from "@/server/app/email-register/existing";
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
import {sendEmailOtp, EmailSendError} from "@/server/mail/resend";
import {
  readMailSettingsConfig,
  resolveFromAddress,
} from "@/server/mail/mail-config";

/**
 * 邮箱验证码下发（邮箱 + 验证码注册 §3.3）。匿名端点——此时用户还没有账号。
 *
 * 检查顺序有意义：先开关（停机手段）→ 邮箱格式（挡脏数据）→ 已注册检查
 * （早期反馈，不发码）→ 限流（挡重发与爆破）。发码成功后 OTP 行已落库，即便
 * 发信失败也返回失败文案——不删行，避免「扣了当日额度却没发信」。
 *
 * 注意：本端点**不做图形验证码**（ADR 修订，移动端不弹码）。发码的防脚本
 * 成本由限流承担，与登录页 `getPicCaptcha` 的强制验码是两条独立链路。
 *
 * 失败一律 `appEnvelope(文案字符串)`：旧后端风格（HTTP 200 + data 为字符串），
 * App 的 RequestHandler 按 data 是否为字符串判定成败。
 */

const OTP_EXPIRE_MINUTES = Math.round(OTP_TTL_MS / 60_000);

/**
 * 从发信异常里取 Resend 的 HTTP 状态码，取不到就给 `unknown`。
 *
 * 只认 `EmailSendError` 自带的 `status` 字段（传输层把 `response.status` 塞进
 * 了错误信息），不解析 `message` 文本——文本形式随时可能变，解析它等于把日志
 * 绑在一个不稳定的字符串格式上。
 */
function statusOf(error: unknown): string {
  if (error instanceof EmailSendError) {
    const matched = /(\d{3})/u.exec(error.message)?.[1];
    if (matched) return matched;
  }
  return "unknown";
}

/**
 * 日志用的邮箱标识：`简单哈希前 8 位`，不是邮箱原文。
 *
 * 目的只是让同一邮箱的多次失败在日志里能聚到一起；不追求密码学强度，
 * 因此用同步的轻量哈希，避免为一个日志字段引入异步 crypto 调用。
 */
function emailLogTag(email: string): string {
  let hash = 0;
  for (let index = 0; index < email.length; index += 1) {
    hash = (hash * 31 + email.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

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

  // 3. 邮箱已注册（早期反馈）：不发码，避免用户走完「发码 → 校验 → 提交」全程
  // 最后才被告知「该邮箱已注册」。放在限流之前：已注册是确定状态，不该占发码额度。
  if (await emailAlreadyRegistered(env.FEED_DB, email)) {
    return jsonResponse(appEnvelope("该邮箱已注册"));
  }

  // 4. 限流：重发间隔 / 当日上限 / IP 窗口
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

  // 5. 生成并存储 OTP（明文只在这一刻存在，落库的是哈希）。走真实随机码，
  // 用户自行收邮件输入，服务端 `checkout` / `register` 校验。
  const code = generateEmailOtp();
  const codeHash = await hashOtp(code, env.BETTER_AUTH_SECRET);
  await storeOtp(env.FEED_DB, email, purpose, codeHash);

  // 6. 发信：模板来自后台「邮件设置」，未配置回落出厂模板
  const settings = await readMailSettingsConfig(db);
  const {subject, html} = renderOtpEmail(settings, code, OTP_EXPIRE_MINUTES);
  const fromAddress = resolveFromAddress(settings, env.RESEND_FROM);

  try {
    await sendEmailOtp(env, email, subject, html, fromAddress);
  } catch (error) {
    // 发信失败不回滚 OTP 行：重发会命中 60s 间隔，用户须稍后再试。
    //
    // 用户端只拿到笼统文案，但服务端必须留痕：线上发信全挂时，光看「发送失败」
    // 无从区分「key 失效 / 域名未验证 / 收件人被拒」。这里只打状态码与邮箱的
    // 非可逆摘要前缀——`EmailSendError` 已带 `status`，且 Resend 响应体可能含
    // 账号信息，所以**不打 error.message 之外的任何原文**。
    // 邮箱用 `simpleHash` 截断前 8 位：同一邮箱在日志里可关联，但不可反推。
    console.error(
      `[emailCodeGet] send failed status=${statusOf(error)} emailHash=${emailLogTag(email)}`,
    );
    return jsonResponse(appEnvelope("验证码发送失败，请稍后重试"));
  }

  return jsonResponse(appEnvelope({}));
};
