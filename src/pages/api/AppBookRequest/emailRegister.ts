import type {APIRoute} from "astro";
import {cache, env} from "cloudflare:workers";

import FeedDb from "@/server/feed/FeedDb";
import {jsonResponse, readStringField} from "@/server/http";
import {appEnvelope} from "@/server/tcm/envelope";
import {createVerifiedEmailUser} from "@/server/auth/email-signup";
import {MIN_ADMIN_PASSWORD_LENGTH} from "@/shared/AdminCredentials";
import {emailRegisterGate} from "@/server/app/email-register/gate";
import {emailAlreadyRegistered} from "@/server/app/email-register/existing";
import {
  DEFAULT_OTP_PURPOSE,
  EMAIL_PATTERN,
  normalizeEmail,
  otpFailureMessage,
  readJsonBody,
} from "@/server/app/email-register/form";
import {consumeOtp, verifyOtp} from "@/server/tcm/email-otp";

/**
 * 邮箱注册建号（邮箱 + 验证码注册 §3.5）。匿名端点。
 *
 * 只建号、**不签发登录凭证**：返回空 Bean，App 随后用 email + password 调
 * `login` 二次登录（与现有手机号注册完全一致的行为，App 侧无新分支）。
 *
 * ## 步骤顺序是有原因的
 *
 * 1. 校验验证码但**不消费**——`emailCodeCheckout` 只做预校验，消费权在这里。
 * 2. 查邮箱是否已占用。放在消费之前：已注册的邮箱不该把用户的验证码烧掉，
 *    他改用登录即可，不必重新收码。
 * 3. 消费验证码。`consumeOtp` 返回 false 说明并发请求先一步删了这行，直接拒。
 * 4. 建号。
 *
 * 查重放在 `verifyOtp` 之后而不是最前面，是为了不把「这个邮箱注册过没有」变成
 * 无需验证码就能问出答案的接口。
 */
export const POST: APIRoute = async ({request}) => {
  const body = await readJsonBody(request);
  const db = new FeedDb(env, request, cache);

  // 1. 开关门
  const gate = await emailRegisterGate(db);
  if (gate) return gate;

  const email = normalizeEmail(body);
  if (!EMAIL_PATTERN.test(email)) {
    return jsonResponse(appEnvelope("邮箱格式不正确"));
  }
  const code = readStringField(body, "code").trim();
  const password = readStringField(body, "password");
  if (!code) {
    return jsonResponse(appEnvelope("验证码错误"));
  }
  if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    return jsonResponse(appEnvelope(`密码长度不足${MIN_ADMIN_PASSWORD_LENGTH}位`));
  }

  // 2. 校验验证码（不消费）
  const otpResult = await verifyOtp(
    env.FEED_DB,
    email,
    DEFAULT_OTP_PURPOSE,
    code,
    env.BETTER_AUTH_SECRET,
  );
  if (!otpResult.ok) {
    return jsonResponse(appEnvelope(otpFailureMessage(otpResult.reason)));
  }

  // 3. 邮箱唯一性（验证码仍然有效）
  if (await emailAlreadyRegistered(env.FEED_DB, email)) {
    return jsonResponse(appEnvelope("该邮箱已注册"));
  }

  // 4. 消费验证码：并发提交同一个码时，只有一次能拿到消费权
  const consumed = await consumeOtp(env.FEED_DB, otpResult.id);
  if (!consumed) {
    return jsonResponse(appEnvelope("验证码无效或已过期"));
  }

  // 5. 建号
  const created = await createVerifiedEmailUser(env, request, email, password);
  if (!created.ok) {
    return jsonResponse(appEnvelope("注册失败，请稍后重试"));
  }

  return jsonResponse(appEnvelope({}));
};
