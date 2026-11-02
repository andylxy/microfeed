import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {updateAdminSignupSources} from "@/server/admin/signup-sources-handler";
import {getSignupSources} from "@/server/auth/signup-source";
import {SETTINGS_CATEGORIES} from "@/shared/Constants";
import type {SignupSourceOption} from "@/shared/SignupSource";

const ORIGIN = "https://feed.example.com";
const ENDPOINT = `${ORIGIN}/admin/ajax/signup-sources`;
const MANAGE = ["system:user:manage"];

/** Minimal `App.Locals` shape `requireRbac` reads. */
function locals(permissions: string[]) {
  return {
    authUser: {id: "u-operator", role: null},
    rbacBanned: false,
    rbacDeviceRevoked: false,
    rbacMustChangePassword: false,
    rbacPermissions: new Set(permissions),
  };
}

function put(sources: unknown, permissions: string[] = MANAGE): Promise<Response> {
  return updateAdminSignupSources({
    locals: locals(permissions),
    request: new Request(ENDPOINT, {
      body: JSON.stringify({sources}),
      headers: {"content-type": "application/json"},
      method: "PUT",
    }),
  } as never) as Promise<Response>;
}

async function reset(): Promise<void> {
  await env.FEED_DB.batch([
    env.FEED_DB.prepare("DELETE FROM ext_user_roles"),
    env.FEED_DB.prepare('DELETE FROM "auth_user"'),
    env.FEED_DB.prepare("DELETE FROM settings WHERE category = ?").bind(
      SETTINGS_CATEGORIES.SIGNUP_SOURCES,
    ),
  ]);
}

async function seedAccount(id: string, source: string): Promise<void> {
  await env.FEED_DB.prepare(
    'INSERT INTO "auth_user" (id, name, email, emailVerified, createdAt, updatedAt, signup_source) ' +
      "VALUES (?, ?, ?, 1, '2024-01-01', '2024-01-01', ?)",
  ).bind(id, id.toUpperCase(), `${id}@example.com`, source).run();
}

const custom: SignupSourceOption = {label: "付费会员", value: "vip"};

beforeEach(reset);

describe("PUT /admin/ajax/signup-sources", () => {
  it("requires system:user:manage", async () => {
    const response = await put([], ["content:book:read"]);
    expect(response.status).toBe(403);
  });

  it("rejects a list that drops a builtin source", async () => {
    // admin / email / qq 是三条建号路径写死的 value，删了下次注册就会写进列表外。
    const response = await put([
      {label: "邮箱注册", value: "email"},
      {label: "QQ 登录", value: "qq"},
    ]);
    expect(response.status).toBe(400);
    expect((await response.json() as {error: string}).error).toContain("admin");
  });

  it("rejects dropping a custom source that still has accounts", async () => {
    expect((await put([
      {label: "管理员", value: "admin"},
      {label: "邮箱注册", value: "email"},
      {label: "QQ 登录", value: "qq"},
      custom,
    ])).status).toBe(200);
    await seedAccount("u-vip", "vip");

    const response = await put([
      {label: "管理员", value: "admin"},
      {label: "邮箱注册", value: "email"},
      {label: "QQ 登录", value: "qq"},
    ]);
    expect(response.status).toBe(409);
    const body = await response.json() as {error: string};
    expect(body.error).toContain("vip");
    // 被拒时不落库：列表仍是四档，那个账号还挂着。
    expect((await getSignupSources(env.FEED_DB)).map((option) => option.value))
      .toEqual(["admin", "email", "qq", "vip"]);
  });

  it("saves a valid list and hands the same array back", async () => {
    const next: SignupSourceOption[] = [
      {label: "管理员", value: "admin"},
      {label: "邮箱注册", value: "email"},
      {label: "QQ 登录", value: "qq"},
      custom,
    ];
    const response = await put(next);
    expect(response.status).toBe(200);
    expect((await response.json() as {sources: SignupSourceOption[]}).sources)
      .toEqual(next);
    expect((await getSignupSources(env.FEED_DB)).map((option) => option.value))
      .toEqual(["admin", "email", "qq", "vip"]);

    const row = await env.FEED_DB.prepare(
      "SELECT data FROM settings WHERE category = ?",
    ).bind(SETTINGS_CATEGORIES.SIGNUP_SOURCES).first<{data: string} | null>();
    expect(JSON.parse(row?.data ?? "[]")).toEqual(next);
  });

  it("rejects an empty list, a duplicate value, and a malformed identifier", async () => {
    expect((await put([])).status).toBe(400);
    expect((await put([
      {label: "甲", value: "vip"},
      {label: "乙", value: "vip"},
    ])).status).toBe(400);
    expect((await put([{label: "大写", value: "Vip"}])).status).toBe(400);
    expect((await put([{label: "   ", value: "vip"}])).status).toBe(400);
    // 「已封禁账号」是系统视图，不能借保存变成来源值。
    expect((await put([{label: "已封禁账号", value: "__banned__"}])).status).toBe(400);
  });

  it("surfaces a hand-written source as a temporary group until it is saved", async () => {
    // 手工 SQL 写进去、配置里也没有的来源。读路径把它补成分组（不写库），
    // 账号因此不会从左栏消失；保存一次就转正。
    await seedAccount("u-partner", "partner");
    const before = await getSignupSources(env.FEED_DB);
    expect(before.map((option) => option.value))
      .toEqual(["admin", "email", "qq", "back", "partner"]);
    expect(before.at(-1)).toEqual({label: "partner", value: "partner"});
    // 没写库：settings 行仍不存在。
    expect(await env.FEED_DB.prepare(
      "SELECT data FROM settings WHERE category = ?",
    ).bind(SETTINGS_CATEGORIES.SIGNUP_SOURCES).first()).toBeNull();

    expect((await put(before)).status).toBe(200);
    const row = await env.FEED_DB.prepare(
      "SELECT data FROM settings WHERE category = ?",
    ).bind(SETTINGS_CATEGORIES.SIGNUP_SOURCES).first<{data: string} | null>();
    expect((JSON.parse(row?.data ?? "[]") as SignupSourceOption[]).at(-1))
      .toEqual({label: "partner", value: "partner"});
  });

  it("allows renaming a builtin without changing its value", async () => {
    const response = await put([
      {label: "后台建的", value: "admin"},
      {label: "邮箱注册", value: "email"},
      {label: "QQ 登录", value: "qq"},
    ]);
    expect(response.status).toBe(200);
    expect((await getSignupSources(env.FEED_DB))[0])
      .toEqual({label: "后台建的", value: "admin"});
  });
});
