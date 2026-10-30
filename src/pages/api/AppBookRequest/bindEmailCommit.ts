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
import {
  BIND_EMAIL_PURPOSE,
  emailTakenByOther,
  isPlaceholderEmail,
} from "@/server/app/email-pwd-reset/identity";
import {bindEmailGate, readMethods} from "@/server/app/email-pwd-reset/gate";
import {
  isResponse,
  requireAppUser,
  verifyReauth,
} from "@/server/app/bind-email/guard";
import {consumeOtp, verifyOtp} from "@/server/tcm/email-otp";
import {
  baseUsername,
  deriveUniqueUsername,
} from "@/server/app/email-register/username";

/**
 * 补充邮箱：验证码提交（ADR-0015 D21 / §9.1 / §9.3）。
 *
 * ## 为什么要再认证两次（send + commit）
 *
 * 只做在 send 上时，攻击者若手里恰好有一张未消费的 `bind_email` 码，仍可绕过。
 * commit 再做一次的成本只是一次腾讯调用（SDK 缓存 token），换来的是"这条链路
 * 每一步都要求本人"。ADR §9.2 的验收用例也按这个口径写。
 *
 * ## 为什么 UPDATE 带占位域条件
 *
 * `AND (lower(email) LIKE '%@oauth.local' OR ...)` 是并发闸：两个设备同时绑不同
 * 邮箱时，第一个成功把 email 改掉，第二个的 WHERE 不再匹配 → `changes = 0`
 * → 拒绝。不需要额外加锁。
 *
 * ## 为什么同批补写 username（F30）
 *
 * App 令牌名 = `前缀 + (username ?? email)`（`login-credentials.ts:183-185`）。
 * `username` 为空的账号改 email 后，令牌名会漂移 → `ensureAppLoginCredential`
 * 认不出旧令牌 → 另建一把 → 撞 5 把上限后登录报「登录凭证数已达上限」。
 * 同批补写后，名字从此稳定在 username 上。
 */
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
  // 目标禁占位域（F28）：否则可把别人的占位地址绑到自己名下，等对方首登时顶号。
  if (isPlaceholderEmail(email)) {
    return jsonResponse(appEnvelope("该邮箱不可用"));
  }
  if (await emailTakenByOther(env.FEED_DB, email, user.userId)) {
    return jsonResponse(appEnvelope("该邮箱已被其他账号使用"));
  }

  const code = readStringField(body, "code").trim();
  if (!code) {
    return jsonResponse(appEnvelope("验证码错误"));
  }

  const otp = await verifyOtp(
    env.FEED_DB,
    email,
    BIND_EMAIL_PURPOSE,
    code,
    env.BETTER_AUTH_SECRET,
  );
  if (!otp.ok) {
    return jsonResponse(appEnvelope(otpFailureMessage(otp.reason)));
  }

  const consumed = await consumeOtp(env.FEED_DB, otp.id);
  if (!consumed) {
    return jsonResponse(appEnvelope("验证码无效或已过期"));
  }

  const current = await env.FEED_DB
    .prepare('SELECT username FROM "auth_user" WHERE id = ? LIMIT 1')
    .bind(user.userId)
    .first<{username: string | null}>();
  const fallbackUsername = current?.username?.trim()
    ? current.username.trim()
    : await deriveUniqueUsername(env.FEED_DB, baseUsername(email));

  const now = new Date().toISOString();
  try {
    const result = await env.FEED_DB
      .prepare(
        'UPDATE "auth_user" SET "email" = ?, "emailVerified" = 1, ' +
          '"username" = COALESCE(NULLIF(trim("username"), \'\'), ?), "updatedAt" = ? ' +
          'WHERE "id" = ? AND (lower("email") LIKE \'%@oauth.local\' ' +
          'OR lower("email") LIKE \'%@users.microfeed.local\')',
      )
      .bind(email, fallbackUsername, now, user.userId)
      .run();
    if ((result.meta?.changes ?? 0) !== 1) {
      return jsonResponse(appEnvelope("该账号已绑定邮箱，如需更换请联系客服"));
    }
  } catch (error) {
    console.error(
      `[bindEmailCommit] update failed: ${error instanceof Error ? error.name : "unknown"}`,
    );
    return jsonResponse(appEnvelope("该邮箱已被其他账号使用"));
  }

  return jsonResponse(appEnvelope({email}));
};
