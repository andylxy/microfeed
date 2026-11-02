import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {env} from "cloudflare:workers";
import {hashPassword} from "better-auth/crypto";

import FeedDb from "@/server/feed/FeedDb";
import {ensureAppLoginCredential} from "@/server/auth/login-credentials";
import {saveLoginMethodsConfig} from "@/server/app/login/config";
import {
  APP_LOGIN_METHODS_CACHE,
  deleteCachedJson,
} from "@/server/cache/app-cache";
import {
  appBindAccount,
  appGetAccountBindings,
  appUnbindAccount,
} from "@/server/tcm/app-account-binding";
import {POST as bindAccountPost} from "@/pages/api/AppBookRequest/bindAccount";

/**
 * QQ 账号绑定（ADR-0014 §4）。
 *
 * 被测的是三个端点在库上留下的结果与失败文案：`auth_account` qq 绑定行
 * （ADR-0055）的重定向、空壳凭证的吊销、解绑的 I14 前置，以及 `bindAccount` 的限流（I15）。
 */

const db = env.FEED_DB;
const PASSWORD = "secret1";
const SHELL_ID = "u_bind_shell";
const TARGET_ID = "u_bind_target";
const SHELL_EMAIL = "qq_OPENID_BIND@users.microfeed.local";
const TARGET_EMAIL = "bind-target@example.com";
const OPENID = "OPENID_BIND";

function request(path = "/api/AppBookRequest/bindAccount", ip?: string): Request {
  const headers: Record<string, string> = {};
  if (ip) headers["cf-connecting-ip"] = ip;
  return new Request(`https://feed.example.com${path}`, {headers, method: "POST"});
}

async function seedShell(): Promise<string> {
  await db.prepare(
    'INSERT INTO "auth_user" (id, name, email, emailVerified, createdAt, updatedAt, ' +
      "role, username, signup_source) VALUES (?, 'QQ 用户', ?, 1, '2024-01-01', " +
      "'2024-01-01', 'user', ?, 'qq')",
  ).bind(SHELL_ID, SHELL_EMAIL, "qq_openid_bind").run();
  await db.prepare(
    "INSERT OR IGNORE INTO auth_account (id, accountId, providerId, userId, createdAt, updatedAt) " +
      "VALUES ('acc_qq_' || ?, ?, 'qq', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
  ).bind(OPENID, OPENID, SHELL_ID).run();
  // 空壳的 mflc_ 令牌：requireAppUser 用它解析当前会话。
  const credential = await ensureAppLoginCredential(db, {
    email: SHELL_EMAIL,
    id: SHELL_ID,
    name: "QQ 用户",
    username: "qq_openid_bind",
  });
  return credential!.secret;
}

async function seedTarget(): Promise<void> {
  await db.prepare(
    'INSERT INTO "auth_user" (id, name, email, emailVerified, createdAt, updatedAt, ' +
      "role, username, signup_source) VALUES (?, '本人', ?, 1, '2024-01-01', " +
      "'2024-01-01', 'user', 'bindtarget', 'email')",
  ).bind(TARGET_ID, TARGET_EMAIL).run();
  await db.prepare(
    "INSERT INTO auth_account (id, accountId, providerId, userId, password, " +
      "createdAt, updatedAt) VALUES (?, ?, 'credential', ?, ?, '2024-01-01', '2024-01-01')",
  ).bind(`acc_${TARGET_ID}`, TARGET_ID, TARGET_ID, await hashPassword(PASSWORD)).run();
}

/**
 * 引用 `auth_user` 的表（含 FK）。清理必须**先删子表再删用户**——
 * `ext_login_credentials` 是 NO ACTION，直接删用户会被 FK 拒绝。
 */
const CHILD_TABLES: Array<[table: string, column: string]> = [
  ["auth_session", "userId"],
  ["auth_account", "userId"],
  ["ext_user_roles", "user_id"],
  ["ext_user_security", "user_id"],
  ["ext_user_devices", "user_id"],
  ["ext_login_credentials", "user_id"],
  ["ext_app_login_log", "user_id"],
];

async function cleanup(): Promise<void> {
  for (const id of [SHELL_ID, TARGET_ID]) {
    for (const [table, column] of CHILD_TABLES) {
      await db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).bind(id).run()
        .catch(() => undefined);
    }
    await db.prepare('DELETE FROM "auth_user" WHERE id = ?').bind(id).run()
      .catch(() => undefined);
  }
  await db.prepare("DELETE FROM settings WHERE category = 'app_login_methods'").run()
    .catch(() => undefined);
  await deleteCachedJson(APP_LOGIN_METHODS_CACHE);
}

beforeEach(async () => {
  await cleanup();
  await saveLoginMethodsConfig(
    new FeedDb(env, request()),
    {loginEnabled: true, qqEnabled: true},
    "u_bind_test",
  );
});

afterEach(cleanup);

describe("getAccountBindings（ADR-0014 §4.0）", () => {
  it("返回绑定状态，且不下发 openid", async () => {
    const token = await seedShell();
    const result = await appGetAccountBindings(
      env as never,
      new Request("https://feed.example.com/api/AppBookRequest/getAccountBindings", {
        headers: {authorization: `Bearer ${token}`},
      }),
    ) as Record<string, unknown>;

    expect(result.QqBound).toBe(1);
    // 空壳没有口令 → 解绑按钮必须禁用（I14）。
    expect(result.HasPassword).toBe(0);
    expect(result.EmailUsable).toBe(0);
    const bindings = result.Bindings as Array<Record<string, unknown>>;
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.Provider).toBe("qq");
    // openid 不下发；QQ 昵称也不下发（绑定后 name 是目标账号自己的，D4）。
    expect(JSON.stringify(result)).not.toContain(OPENID);
    expect(result.signup_source).toBeUndefined();
  });
});

describe("bindAccount（ADR-0014 §4.1）", () => {
  it("把 openid 重定向到目标账号，吊销空壳凭证，返回目标账号会话", async () => {
    const token = await seedShell();
    await seedTarget();

    const payload = await appBindAccount(
      env as never,
      new Request("https://feed.example.com/api/AppBookRequest/bindAccount", {
        headers: {authorization: `Bearer ${token}`},
        method: "POST",
      }),
      {email: TARGET_EMAIL, password: PASSWORD},
    ) as Record<string, unknown>;

    expect(payload.Token).toMatch(/^mflc_/u);
    expect(payload.Account).toBe("bindtarget");
    expect(payload.Email).toBe(TARGET_EMAIL);

    // openid 已归目标账号。
    const moved = await db.prepare(
      "SELECT userId FROM auth_account WHERE providerId = 'qq' AND accountId = ? LIMIT 1",
    ).bind(OPENID).first<{userId: string}>();
    expect(moved!.userId).toBe(TARGET_ID);

    // 空壳凭证全部吊销（D7 / G3），含本次请求用的那一把。
    const left = await db.prepare(
      "SELECT COUNT(*) AS c FROM ext_login_credentials WHERE user_id = ? AND revoked = 0",
    ).bind(SHELL_ID).first<{c: number}>();
    expect(left!.c).toBe(0);

    // 空壳账号本身保留（I6，只失活不删除）。
    const shell = await db.prepare(
      'SELECT COUNT(*) AS c FROM "auth_user" WHERE id = ?',
    ).bind(SHELL_ID).first<{c: number}>();
    expect(shell!.c).toBe(1);
  });

  it("当前会话没有 QQ 绑定 → 拒绝", async () => {
    const token = await seedShell();
    await seedTarget();
    await db.prepare(
      "DELETE FROM auth_account WHERE providerId = 'qq' AND userId = ?",
    ).bind(SHELL_ID).run();

    expect(await appBindAccount(
      env as never,
      new Request("https://feed.example.com/api/AppBookRequest/bindAccount", {
        headers: {authorization: `Bearer ${token}`},
        method: "POST",
      }),
      {email: TARGET_EMAIL, password: PASSWORD},
    )).toBe("该账号未关联 QQ，请先用 QQ 登录");
  });

  it("目标就是当前账号 → 「已是同一账号」", async () => {
    const token = await seedShell();
    expect(await appBindAccount(
      env as never,
      new Request("https://feed.example.com/api/AppBookRequest/bindAccount", {
        headers: {authorization: `Bearer ${token}`},
        method: "POST",
      }),
      {email: SHELL_EMAIL, password: PASSWORD},
    )).toBe("已是同一账号");
  });

  it("目标不存在 / 无口令 / 口令错，都是同一句文案（防枚举）", async () => {
    const token = await seedShell();
    const authorized = new Request(
      "https://feed.example.com/api/AppBookRequest/bindAccount", {
        headers: {authorization: `Bearer ${token}`},
        method: "POST",
      });

    // 不存在。
    expect(await appBindAccount(env as never, authorized,
      {email: "nobody@example.com", password: PASSWORD})).toBe("账号或密码错误");

    await seedTarget();
    // 口令错。
    expect(await appBindAccount(env as never, authorized,
      {email: TARGET_EMAIL, password: "wrong-one"})).toBe("账号或密码错误");

    // 删掉目标口令行 → 无口令，同样一句。
    await db.prepare("DELETE FROM auth_account WHERE userId = ?").bind(TARGET_ID).run();
    expect(await appBindAccount(env as never, authorized,
      {email: TARGET_EMAIL, password: PASSWORD})).toBe("账号或密码错误");
  });

  it("缺参数 → 「参数缺失，请重试」", async () => {
    const token = await seedShell();
    const authorized = new Request(
      "https://feed.example.com/api/AppBookRequest/bindAccount", {
        headers: {authorization: `Bearer ${token}`},
        method: "POST",
      });
    expect(await appBindAccount(env as never, authorized, {email: TARGET_EMAIL}))
      .toBe("参数缺失，请重试");
  });

  it("I15：同一 IP 60s 内第 6 次调用返回 429", async () => {
    const ip = "203.0.113.7";
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const response = await bindAccountPost({
        request: request("/api/AppBookRequest/bindAccount", ip),
      } as never);
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 5).every((status) => status === 200)).toBe(true);
    expect(statuses[5]).toBe(429);
    await db.prepare(
      "DELETE FROM ext_rate_limit WHERE kind = 'auth-throttle' AND key LIKE ?",
    )
      .bind(`${ip}:%`).run();
  });
});

describe("unbindAccount（ADR-0014 §4.2）", () => {
  it("I14：没有口令时拒绝解绑（否则账号两条登录通路全断）", async () => {
    const token = await seedShell();
    expect(await appUnbindAccount(
      env as never,
      new Request("https://feed.example.com/api/AppBookRequest/unbindAccount", {
        headers: {authorization: `Bearer ${token}`},
        method: "POST",
      }),
      {provider: "qq"},
    )).toBe("请先补充邮箱并设置密码后再解绑");

    // 绑定行仍在。
    const left = await db.prepare(
      "SELECT COUNT(*) AS c FROM auth_account WHERE providerId = 'qq' AND userId = ?",
    ).bind(SHELL_ID).first<{c: number}>();
    expect(left!.c).toBe(1);
  });

  it("有口令时删除当前会话名下全部 qq 行（不收 openid）", async () => {
    const token = await seedShell();
    await db.prepare(
      "INSERT INTO auth_account (id, accountId, providerId, userId, password, " +
        "createdAt, updatedAt) VALUES (?, ?, 'credential', ?, ?, '2024-01-01', '2024-01-01')",
    ).bind(`acc_${SHELL_ID}`, SHELL_ID, SHELL_ID, await hashPassword(PASSWORD)).run();

    expect(await appUnbindAccount(
      env as never,
      new Request("https://feed.example.com/api/AppBookRequest/unbindAccount", {
        headers: {authorization: `Bearer ${token}`},
        method: "POST",
      }),
      {provider: "qq"},
    )).toEqual({QqBound: 0});

    const left = await db.prepare(
      "SELECT COUNT(*) AS c FROM auth_account WHERE providerId = 'qq' AND userId = ?",
    ).bind(SHELL_ID).first<{c: number}>();
    expect(left!.c).toBe(0);
  });

  it("provider 不是 qq → 「参数缺失，请重试」", async () => {
    const token = await seedShell();
    expect(await appUnbindAccount(
      env as never,
      new Request("https://feed.example.com/api/AppBookRequest/unbindAccount", {
        headers: {authorization: `Bearer ${token}`},
        method: "POST",
      }),
      {provider: "wechat"},
    )).toBe("参数缺失，请重试");
  });

  it("没有任何绑定 → 「未找到该绑定」", async () => {
    const token = await seedShell();
    await db.prepare(
      "INSERT INTO auth_account (id, accountId, providerId, userId, password, " +
        "createdAt, updatedAt) VALUES (?, ?, 'credential', ?, ?, '2024-01-01', '2024-01-01')",
    ).bind(`acc_${SHELL_ID}`, SHELL_ID, SHELL_ID, await hashPassword(PASSWORD)).run();
    await db.prepare(
      "DELETE FROM auth_account WHERE providerId = 'qq' AND userId = ?",
    ).bind(SHELL_ID).run();

    expect(await appUnbindAccount(
      env as never,
      new Request("https://feed.example.com/api/AppBookRequest/unbindAccount", {
        headers: {authorization: `Bearer ${token}`},
        method: "POST",
      }),
      {provider: "qq"},
    )).toBe("未找到该绑定");
  });
});
