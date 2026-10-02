import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {env} from "cloudflare:workers";

import {createAdminRbacUser} from "@/server/admin/rbac-handlers";
import {createLoginSessionCookies} from "@/server/auth/login-session";
import {verifyLoginCredentialToken} from "@/server/auth/login-credentials";
import {appLogin, appReplaceToken} from "@/server/tcm/app-auth";
import {
  emptyPicCaptcha,
  getAppAboutInfo,
  getAppLoginInfo,
  getAppProjectInfo,
} from "@/server/tcm/config";

const db = env.FEED_DB;
const ORIGIN = "https://feed.example.com";
const CREATE_URL = `${ORIGIN}/admin/ajax/rbac/user-create`;
const ADMIN_ID = "u_appauth_admin";
const CHANNEL_ID = "apptcmttest";

let adminCookie = "";

function locals(userId: string, permissions: string[] = ["system:user:manage"]) {
  return {
    authUser: {id: userId, role: null},
    rbacBanned: false,
    rbacDeviceRevoked: false,
    rbacMustChangePassword: false,
    rbacPermissions: new Set(permissions),
  };
}

async function seedAdmin(): Promise<void> {
  await db.prepare(
    'INSERT INTO "auth_user" (id, name, email, emailVerified, createdAt, updatedAt, role, banned) ' +
      "VALUES (?, ?, ?, 1, '2024-01-01', '2024-01-01', 'admin', 0)",
  ).bind(ADMIN_ID, "Admin", "admin@example.com").run();
  const cookies = await createLoginSessionCookies(
    env,
    new Request(`${ORIGIN}/admin/`),
    ADMIN_ID,
  );
  adminCookie = cookies[0]!.split(";")[0]!;
}

async function createAccount(body: Record<string, unknown>): Promise<Response> {
  return createAdminRbacUser({
    locals: locals(ADMIN_ID),
    request: new Request(CREATE_URL, {
      body: JSON.stringify(body),
      headers: {cookie: adminCookie, origin: ORIGIN},
      method: "POST",
    }),
  } as never);
}

function appRequest(url: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${url}`, init);
}

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM ext_login_credentials"),
    db.prepare("DELETE FROM auth_account"),
    db.prepare("DELETE FROM auth_session"),
    db.prepare("DELETE FROM ext_user_security"),
    db.prepare("DELETE FROM ext_user_roles"),
    db.prepare('DELETE FROM "auth_user"'),
    db.prepare("DELETE FROM channels WHERE id = ?").bind(CHANNEL_ID),
    db.prepare("DELETE FROM settings WHERE category = 'webGlobalSettings'"),
  ]);
  await seedAdmin();
});

afterEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM ext_login_credentials"),
    db.prepare("DELETE FROM channels WHERE id = ?").bind(CHANNEL_ID),
    db.prepare("DELETE FROM settings WHERE category = 'webGlobalSettings'"),
  ]);
});

async function seedPrimaryChannel(data: Record<string, unknown>): Promise<void> {
  await db.prepare(
    "INSERT OR REPLACE INTO channels (id, status, is_primary, data) VALUES (?, 1, 1, ?)",
  ).bind(CHANNEL_ID, JSON.stringify(data)).run();
}

describe("App login (ticket 12)", () => {
  it("signs in by username and issues an mflc_ login credential", async () => {
    await createAccount({account: "appuser", name: "App User", password: "secret1"});

    const payload = await appLogin(env, appRequest("/api/AppBookRequest/login"), {
      UserName: "appuser",
      Password: "secret1",
    }) as Record<string, unknown>;

    expect(typeof payload.Token).toBe("string");
    // 签发的是绑定该用户的 mflc_ 登录凭证（用户 → 角色 → 权限 模型），
    // 不是设备级 mf_ API Key。
    expect(payload.Token as string).toMatch(/^mflc_/u);
    expect(payload.Account).toBe("appuser");
    expect(payload.UserName).toBe("appuser");
    expect(payload.Name).toBe("App User");
    expect(payload.DefaultModule).toBeNull();
    // 凭证可解析回该用户（Bearer 走 decideLoginCredentialApiRequest）。
    const verified = await verifyLoginCredentialToken(db, payload.Token as string);
    expect(verified).not.toBeNull();
  });

  it("reuses the same credential across repeated logins", async () => {
    await createAccount({account: "reuse", name: "Reuse", password: "secret1"});
    const first = await appLogin(env, appRequest("/api/AppBookRequest/login"), {
      UserName: "reuse",
      Password: "secret1",
    }) as Record<string, unknown>;
    const second = await appLogin(env, appRequest("/api/AppBookRequest/login"), {
      UserName: "reuse",
      Password: "secret1",
    }) as Record<string, unknown>;
    expect(second.Token).toBe(first.Token);
  });

  it("signs in by email address", async () => {
    await createAccount({account: "Mail@Example.com", name: "Mail", password: "secret1"});

    const payload = await appLogin(env, appRequest("/api/AppBookRequest/login"), {
      UserName: "mail@example.com",
      Password: "secret1",
    }) as Record<string, unknown>;

    expect(typeof payload.Token).toBe("string");
    expect(payload.Account).toBe("mail@example.com");
  });

  it("rejects a wrong password without leaking account existence", async () => {
    await createAccount({account: "gooduser", name: "Good", password: "secret1"});
    const wrong = await appLogin(env, appRequest("/api/AppBookRequest/login"), {
      UserName: "gooduser",
      Password: "wrong-password",
    });
    expect(wrong).toBe("登录失败,请检查账号密码");

    const unknown = await appLogin(env, appRequest("/api/AppBookRequest/login"), {
      UserName: "nobody-here",
      Password: "whatever1",
    });
    expect(unknown).toBe("登录失败,请检查账号密码");
  });

  it("returns the legacy empty-input message for missing fields", async () => {
    expect(await appLogin(env, appRequest("/api/AppBookRequest/login"), null))
      .toBe("请检查账号密码");
    expect(await appLogin(env, appRequest("/api/AppBookRequest/login"), {
      UserName: "x",
    })).toBe("请检查账号密码");
  });

  it("replaceToken echoes a valid Bearer key and rejects invalid ones", async () => {
    await createAccount({account: "refresh", name: "Refresh", password: "secret1"});
    const payload = await appLogin(env, appRequest("/api/AppBookRequest/login"), {
      UserName: "refresh",
      Password: "secret1",
    }) as Record<string, unknown>;
    const token = payload.Token as string;

    const refreshed = await appReplaceToken(db, appRequest(
      "/api/AppBookRequest/replaceToken",
      {headers: {authorization: `Bearer ${token}`}},
    )) as Record<string, unknown>;
    expect(refreshed.Token).toBe(token);
    expect(refreshed.Account).toBe("refresh");

    const invalid = await appReplaceToken(db, appRequest(
      "/api/AppBookRequest/replaceToken",
      {headers: {authorization: "Bearer not-a-real-key"}},
    ));
    expect(invalid).toBe("凭证无效或已过期");

    const missing = await appReplaceToken(db, appRequest("/api/AppBookRequest/replaceToken"));
    expect(missing).toBe("请先登录");
  });
});

describe("App site config (ticket 13)", () => {
  it("maps project info from the primary channel", async () => {
    await seedPrimaryChannel({
      title: "中医典籍",
      description: "典籍站点说明",
      image: "https://media.example.com/logo.png",
    });

    const info = await getAppProjectInfo(db) as Record<string, unknown>;
    expect(info.systemName).toBe("中医典籍");
    expect(info.systemDescription).toBe("典籍站点说明");
    expect(info.systemLogo).toBe("https://media.example.com/logo.png");
    expect(info.systemVersion).toBe("");
    // 旧后端列表类配置缺失时返回 string.Empty，保持一致。
    expect(info.sysDefaultLinksIcon).toBe("");
  });

  it("degrades to empty strings without a primary channel", async () => {
    const info = await getAppProjectInfo(db) as Record<string, unknown>;
    expect(info.systemName).toBe("");
    expect(info.systemLogo).toBe("");

    const loginInfo = await getAppLoginInfo(db) as Record<string, unknown>;
    expect(loginInfo.vierificationCode).toBe("false");
    expect(loginInfo.systemName).toBe("");
  });

  it("getAboutInfo defaults to an empty array and reads configured entries", async () => {
    expect(await getAppAboutInfo(db)).toEqual([]);

    await db.prepare(
      "INSERT OR REPLACE INTO settings (category, data) VALUES ('webGlobalSettings', ?)",
    ).bind(JSON.stringify({
      aboutInfo: [{text: "关于本站", name: "v1"}],
    })).run();
    expect(await getAppAboutInfo(db)).toEqual([{text: "关于本站", name: "v1"}]);
  });

  it("pic captcha returns the legacy empty shape", () => {
    expect(emptyPicCaptcha()).toEqual({
      ValidCodeBase64: "",
      ValidCodeReqNo: "",
      IsCode: false,
    });
  });
});
