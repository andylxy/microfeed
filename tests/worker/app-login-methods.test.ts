import {afterEach, describe, expect, it} from "vitest";
import {env} from "cloudflare:workers";

import FeedDb from "@/server/feed/FeedDb";
import {GET as getLoginMethodsGet} from "@/pages/api/AppBookRequest/getLoginMethods";
import {
  GET as ajaxLoginMethodsGet,
} from "@/pages/[adminPath]/ajax/login-methods/index";
import {
  POST as ajaxLoginMethodsSave,
} from "@/pages/[adminPath]/ajax/login-methods/save";
import {
  APP_BOOK_REQUEST_ANONYMOUS_ROUTES,
  APP_BOOK_REQUEST_CONTENT_SUFFIXES,
  APP_BOOK_REQUEST_ROUTES,
} from "@/server/api/access";
import {saveLoginMethodsConfig} from "@/server/app/login/config";
import {
  APP_LOGIN_METHODS_CACHE,
  deleteCachedJson,
} from "@/server/cache/app-cache";
import {readLoginMethodsConfig} from "@/server/app/login/config";

const db = env.FEED_DB;
const ORIGIN = "https://feed.example.com";

function newDb(): FeedDb {
  return new FeedDb(env, new Request(ORIGIN));
}

function locals(userId: string, permissions: string[]) {
  return {
    authUser: {id: userId, role: null},
    rbacBanned: false,
    rbacDeviceRevoked: false,
    rbacMustChangePassword: false,
    rbacPermissions: new Set(permissions),
  };
}

async function save(patch: Record<string, boolean>): Promise<void> {
  const result = await saveLoginMethodsConfig(newDb(), patch, "u_test_admin");
  expect(result).toEqual({ok: true});
}

afterEach(async () => {
  await db.prepare(
    "DELETE FROM settings WHERE category = 'app_login_methods'",
  ).run();
  await deleteCachedJson(APP_LOGIN_METHODS_CACHE);
});

describe("getLoginMethods endpoint (ADR-0050)", () => {
  it("is registered as an anonymous pre-auth route, not a content route", () => {
    // 归一化表与匿名表都要有（缺匿名行 = 接口清单少一行 + fail-open 缺口）；
    // 内容表必须没有（它不需要登录凭证）。
    expect(APP_BOOK_REQUEST_ROUTES).toContain("getLoginMethods");
    expect(APP_BOOK_REQUEST_ANONYMOUS_ROUTES).toContain("getLoginMethods");
    expect(APP_BOOK_REQUEST_CONTENT_SUFFIXES.has("AppBookRequest/getLoginMethods/")).toBe(false);
  });

  it("returns the default config in the app envelope when nothing is saved", async () => {
    const response = await getLoginMethodsGet({
      request: new Request(`${ORIGIN}/api/AppBookRequest/getLoginMethods`),
    } as never);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      code: number;
      data: Record<string, unknown>;
      msg: string;
    };
    expect(body.code).toBe(200);
    expect(body.msg).toBe("请求成功");
    expect(body.data).toEqual({
      loginEnabled: true,
      accountPasswordEnabled: true,
      smsEnabled: false,
      wechatEnabled: false,
      qqEnabled: false,
      captchaEnabled: true,
      updatedAtMs: 0,
    });
  });

  it("reflects a saved config and never leaks updatedBy", async () => {
    await save({captchaEnabled: false, qqEnabled: true});
    const response = await getLoginMethodsGet({
      request: new Request(`${ORIGIN}/api/AppBookRequest/getLoginMethods`),
    } as never);
    const body = await response.json() as {data: Record<string, unknown>};
    expect(body.data).toMatchObject({
      accountPasswordEnabled: true,
      captchaEnabled: false,
      qqEnabled: true,
    });
    expect(body.data.updatedBy).toBeUndefined();
    expect(typeof body.data.updatedAtMs).toBe("number");
    expect(body.data.updatedAtMs).toBeGreaterThan(0);
  });
});

describe("admin ajax login-methods (ADR-0050)", () => {
  const READ_URL = `${ORIGIN}/admin/ajax/login-methods/`;
  const SAVE_URL = `${ORIGIN}/admin/ajax/login-methods/save`;

  it("read endpoint returns the config for :read holders", async () => {
    const response = await ajaxLoginMethodsGet({
      locals: locals("u_reader", ["system:app-login-methods:read"]),
      request: new Request(READ_URL),
    } as never);
    expect(response.status).toBe(200);
    const body = await response.json() as {config: Record<string, unknown>};
    expect(body.config).toEqual({
      loginEnabled: true,
      accountPasswordEnabled: true,
      smsEnabled: false,
      wechatEnabled: false,
      qqEnabled: false,
      captchaEnabled: true,
      updatedAtMs: 0,
      updatedBy: null,
    });
  });

  it("read endpoint rejects accounts without :read", async () => {
    const response = await ajaxLoginMethodsGet({
      locals: locals("u_nobody", []),
      request: new Request(READ_URL),
    } as never);
    expect(response.status).toBe(403);
  });

  it("save endpoint writes the patch for :manage holders and records the operator", async () => {
    const response = await ajaxLoginMethodsSave({
      locals: locals("u_manager", ["system:app-login-methods:manage"]),
      request: new Request(SAVE_URL, {
        body: JSON.stringify({patch: {captchaEnabled: false}}),
        headers: {"content-type": "application/json"},
        method: "POST",
      }),
    } as never);
    expect(response.status).toBe(200);
    const stored = await readLoginMethodsConfig(newDb());
    expect(stored.captchaEnabled).toBe(false);
    expect(stored.updatedBy).toBe("u_manager");
    expect(stored.updatedAtMs).toBeGreaterThan(0);
  });

  it("save endpoint maps a non-boolean patch to a clean 400", async () => {
    const response = await ajaxLoginMethodsSave({
      locals: locals("u_manager", ["system:app-login-methods:manage"]),
      request: new Request(SAVE_URL, {
        body: JSON.stringify({patch: {captchaEnabled: "no"}}),
        headers: {"content-type": "application/json"},
        method: "POST",
      }),
    } as never);
    expect(response.status).toBe(400);
    expect(await readLoginMethodsConfig(newDb())).toEqual({
      loginEnabled: true,
      accountPasswordEnabled: true,
      smsEnabled: false,
      wechatEnabled: false,
      qqEnabled: false,
      captchaEnabled: true,
      updatedAtMs: 0,
      updatedBy: null,
    });
  });

  it("save endpoint rejects accounts without :manage", async () => {
    const response = await ajaxLoginMethodsSave({
      locals: locals("u_reader", ["system:app-login-methods:read"]),
      request: new Request(SAVE_URL, {
        body: JSON.stringify({patch: {captchaEnabled: false}}),
        headers: {"content-type": "application/json"},
        method: "POST",
      }),
    } as never);
    expect(response.status).toBe(403);
  });
});
