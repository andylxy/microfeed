import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {env} from "cloudflare:workers";
import {hashPassword} from "better-auth/crypto";

import {verifyReauth} from "@/server/app/bind-email/guard";

/**
 * 再认证守卫（ADR-0014 D10 / I17）。
 *
 * 被测的是「操作者是不是本人」这个判断本身，而不是两个调用它的端点
 * （`bindEmailSend` / `bindEmailCommit`）——端点侧还有 OTP、配额、占位域校验，
 * 那些各自的逻辑不在这里。
 *
 * dev-mock（`QQ_OAUTH_DEV_MOCK=1` + 本机 host）用来跳过腾讯调用；旁路仍然要求
 * openid 映射回当前 userId，所以「拿别人的 openid」这类归属错误照样测得出来。
 */

const db = env.FEED_DB;
const PASSWORD = "secret1";

function mockEnv(): Env {
  return {
    ...env,
    QQ_APP_ID: "1906152522",
    QQ_APP_SECRET: "test-app-key",
    QQ_OAUTH_DEV_MOCK: "1",
  } as unknown as Env;
}

function localRequest(): Request {
  return new Request("http://127.0.0.1/api/AppBookRequest/bindEmailSend", {
    method: "POST",
  });
}

async function seedUser(
  id: string,
  email: string,
  options: {password?: boolean; qqOpenid?: string} = {},
): Promise<void> {
  await db.prepare(
    'INSERT INTO "auth_user" (id, name, email, emailVerified, createdAt, updatedAt, role) ' +
      "VALUES (?, ?, ?, 1, '2024-01-01', '2024-01-01', 'user')",
  ).bind(id, id, email).run();

  if (options.password) {
    await db.prepare(
      "INSERT INTO auth_account (id, accountId, providerId, userId, password, " +
        "createdAt, updatedAt) VALUES (?, ?, 'credential', ?, ?, '2024-01-01', '2024-01-01')",
    ).bind(`acc_${id}`, id, id, await hashPassword(PASSWORD)).run();
  }
  if (options.qqOpenid) {
    await db.prepare(
      "INSERT OR IGNORE INTO auth_account (id, accountId, providerId, userId, createdAt, updatedAt) " +
        "VALUES ('acc_qq_' || ?, ?, 'qq', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
    ).bind(options.qqOpenid, options.qqOpenid, id).run();
  }
}

const IDS = ["u_pwd_only", "u_qq_only", "u_both", "u_neither"];

afterEach(async () => {
  await db.batch([
    ...IDS.map((id) =>
      db.prepare('DELETE FROM "auth_user" WHERE id = ?').bind(id)),
    ...IDS.map((id) =>
      db.prepare("DELETE FROM auth_account WHERE userId = ?").bind(id)),
  ]);
});

beforeEach(async () => {
  await db.batch(IDS.map((id) =>
    db.prepare('DELETE FROM "auth_user" WHERE id = ?').bind(id)));
});

describe("verifyReauth（ADR-0014 D10）", () => {
  it("口令账号：带当前口令即通过", async () => {
    await seedUser("u_pwd_only", "pwd-only@example.com", {password: true});
    const result = await verifyReauth(
      mockEnv(), localRequest(), "u_pwd_only", {password: PASSWORD},
    );
    expect(result).toBeNull();
  });

  it("口令账号：口令错误即拒绝", async () => {
    await seedUser("u_pwd_only", "pwd-only@example.com", {password: true});
    const result = await verifyReauth(
      mockEnv(), localRequest(), "u_pwd_only", {password: "wrong-one"},
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(200);
  });

  it("纯 QQ 账号：openid 映射回本人即通过", async () => {
    await seedUser("u_qq_only", "qq_OPENID_REAUTH@users.microfeed.local",
      {qqOpenid: "OPENID_REAUTH"});
    const result = await verifyReauth(
      mockEnv(), localRequest(), "u_qq_only",
      {openid: "OPENID_REAUTH", accessToken: "tok"},
    );
    expect(result).toBeNull();
  });

  it("纯 QQ 账号：openid 属于别人则拒绝（归属校验不因旁路放松）", async () => {
    await seedUser("u_qq_only", "qq_OPENID_REAUTH@users.microfeed.local",
      {qqOpenid: "OPENID_REAUTH"});
    await seedUser("u_both", "other@example.com", {qqOpenid: "OPENID_OTHER"});
    const result = await verifyReauth(
      mockEnv(), localRequest(), "u_qq_only",
      {openid: "OPENID_OTHER", accessToken: "tok"},
    );
    expect(result).not.toBeNull();
  });

  it("口令 + QQ 双全：绑定后**仍能用口令**通过（D10 新增能力）", async () => {
    await seedUser("u_both", "both@example.com",
      {password: true, qqOpenid: "OPENID_BOTH"});
    // 关键回归：改造前这里是 if/else 独占，有 QQ 绑定就只认 accessToken，
    // 而 Android 不持久化 accessToken → 该账号再也过不了再认证。
    const result = await verifyReauth(
      mockEnv(), localRequest(), "u_both", {password: PASSWORD},
    );
    expect(result).toBeNull();
  });

  it("口令 + QQ 双全：口令错且没有 QQ 凭据 → 拒绝（不因为多一条通道就放宽）", async () => {
    await seedUser("u_both", "both@example.com",
      {password: true, qqOpenid: "OPENID_BOTH"});
    const result = await verifyReauth(
      mockEnv(), localRequest(), "u_both", {password: "wrong-one"},
    );
    expect(result).not.toBeNull();
  });

  it("既无口令也无 QQ 绑定：一律拒绝", async () => {
    await seedUser("u_neither", "neither@example.com");
    expect(await verifyReauth(mockEnv(), localRequest(), "u_neither", {password: PASSWORD}))
      .not.toBeNull();
    expect(await verifyReauth(
      mockEnv(), localRequest(), "u_neither", {openid: "X", accessToken: "t"},
    )).not.toBeNull();
  });
});
