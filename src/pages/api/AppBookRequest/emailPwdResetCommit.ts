import type {APIRoute} from "astro";
import {cache, env} from "cloudflare:workers";
import {hashPassword} from "better-auth/crypto";

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
  PWD_RESET_PURPOSE,
  findEmailAccount,
  isPlaceholderEmail,
} from "@/server/app/email-pwd-reset/identity";
import {pwdResetGate, readMethods} from "@/server/app/email-pwd-reset/gate";
import {consumeOtp, verifyOtp} from "@/server/tcm/email-otp";
import {validateAdminPassword} from "@/shared/AdminCredentials";

/**
 * 忘记密码：提交新口令（ADR-0015 D6/D12/D13）。匿名端点。
 *
 * ## 顺序（每一步都有原因）
 *
 * 1. 校验验证码（不消费）→ 2. 定位账号 → 3. **先抢消费权** → 4. 一个 batch 里
 * 落口令 + 清会话 + 吊销 App 令牌 + 置 emailVerified。
 *
 * 消费权必须先抢：如果「先改口令、后消费」，两个并发请求都能通过校验（都不消费），
 * 各自 UPDATE，后写者覆盖先写者，而先写者已经被告知"成功"（ADR-0015 F11）。
 *
 * ## 口令写入是 UPSERT，不是 UPDATE
 *
 * QQ 账号绑了邮箱后仍然没有 credential 行（从来没有口令）。如果只 UPDATE，
 * `changes === 0` 会让"重置成功"变成假象（F8）。所以 batch 里同时放
 * UPDATE 与 `INSERT ... WHERE NOT EXISTS`，两者恰好命中一个：
 * - `upd === 1`：已有口令行，正常重置；
 * - `ins === 1`：首次设口令，建行（`accountId` 取 `userId`，与 better-auth 建号一致）；
 * - 合计 ≠ 1：重复行（>1）或并发抢先（0），拒绝。
 *
 * 注意：走到"合计 ≠ 1"时验证码已被消费，用户需要重新发码——这是有意的，
 * 因为继续重试同一个码会让"消费权"失去意义。
 *
 * ## 为什么要清会话与 App 令牌
 *
 * better-auth 的 `revokeSessionsOnPasswordReset` 只对**它自己的**重置端点生效，
 * 这里是裸 SQL，不会触发。而 App 的实际鉴权凭证是 `ext_login_credentials`
 * （`mflc_` 令牌），不是 `auth_session`——只清会话对 App 无效（F10）。
 * 两处都清，沿用 `password-setup.ts:367/372` 的既有做法。
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

  const password = readStringField(body, "password");
  const passwordError = validateAdminPassword(password);
  if (passwordError) {
    return jsonResponse(
      appEnvelope("密码需 6–128 位，且包含数字或大小写混合"),
    );
  }

  const otp = await verifyOtp(
    env.FEED_DB,
    email,
    PWD_RESET_PURPOSE,
    code,
    env.BETTER_AUTH_SECRET,
  );
  if (!otp.ok) {
    return jsonResponse(appEnvelope(otpFailureMessage(otp.reason)));
  }

  const account = await findEmailAccount(env.FEED_DB, email);
  if (!account || isPlaceholderEmail(account.email)) {
    return jsonResponse(appEnvelope("验证码无效或已过期"));
  }

  // 先抢消费权：并发下只有一次能拿到 changes === 1。
  const consumed = await consumeOtp(env.FEED_DB, otp.id);
  if (!consumed) {
    return jsonResponse(appEnvelope("验证码无效或已过期"));
  }

  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();

  const results = await env.FEED_DB.batch([
    env.FEED_DB.prepare(
      'UPDATE "auth_account" SET "password" = ?, "updatedAt" = ? ' +
        'WHERE "userId" = ? AND "providerId" = \'credential\'',
    ).bind(passwordHash, now, account.id),
    env.FEED_DB.prepare(
      'INSERT INTO "auth_account" ' +
        '("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt") ' +
        "SELECT ?, ?, 'credential', ?, ?, ?, ? " +
        "WHERE NOT EXISTS (" +
        'SELECT 1 FROM "auth_account" WHERE "userId" = ? AND "providerId" = \'credential\')',
    ).bind(
      crypto.randomUUID(),
      account.id,
      account.id,
      passwordHash,
      now,
      now,
      account.id,
    ),
    env.FEED_DB.prepare('DELETE FROM "auth_session" WHERE "userId" = ?').bind(account.id),
    env.FEED_DB.prepare(
      "UPDATE ext_login_credentials SET revoked = 1 WHERE user_id = ? AND revoked = 0",
    ).bind(account.id),
    env.FEED_DB.prepare(
      'UPDATE "auth_user" SET "emailVerified" = 1, "updatedAt" = ? WHERE "id" = ?',
    ).bind(now, account.id),
  ]);

  const updated = results[0]?.meta?.changes ?? 0;
  const inserted = results[1]?.meta?.changes ?? 0;
  if (updated + inserted !== 1) {
    console.error(
      `[emailPwdResetCommit] 口令行异常 updated=${updated} inserted=${inserted} userId=${account.id}`,
    );
    return jsonResponse(appEnvelope("该账号不支持自助重置，请联系客服"));
  }

  return jsonResponse(appEnvelope({}));
};
