import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {env} from "cloudflare:workers";

import {createAdminRbacUser} from "@/server/admin/rbac-handlers";
import {createLoginSessionCookies} from "@/server/auth/login-session";
import {
  listLoginCredentialsForUser,
  verifyLoginCredentialToken,
} from "@/server/auth/login-credentials";
import FeedDb from "@/server/feed/FeedDb";
import {appLogin} from "@/server/tcm/app-auth";
import {POST as appLoginPost} from "@/pages/api/AppBookRequest/login";
import {GET as getPicCaptchaGet} from "@/pages/api/AppBookRequest/getPicCaptcha";
import {generateCaptcha} from "@/server/tcm/captcha";
import {getAppAboutInfo} from "@/server/tcm/config";
import {saveLoginMethodsConfig} from "@/server/app/login/config";
import {
  APP_LOGIN_METHODS_CACHE,
  deleteCachedJson,
} from "@/server/cache/app-cache";

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

/** 每次登录都带一张新签发的有效图形验证码（策略 A：强制验证码）。 */
async function withCaptcha(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const {code, reqNo} = await generateCaptcha(env.BETTER_AUTH_SECRET);
  return {...body, VerificationCode: code, UUID: reqNo};
}

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM ext_login_credentials"),
    db.prepare("DELETE FROM auth_account"),
    db.prepare("DELETE FROM auth_session"),
    db.prepare("DELETE FROM ext_user_security"),
    db.prepare("DELETE FROM ext_user_roles"),
    db.prepare("DELETE FROM ext_user_devices"),
    db.prepare("DELETE FROM ext_auth_throttle"),
    db.prepare('DELETE FROM "auth_user"'),
    db.prepare("DELETE FROM channels WHERE id = ?").bind(CHANNEL_ID),
    db.prepare("DELETE FROM settings WHERE category = 'webGlobalSettings'"),
  ]);
  await seedAdmin();
});

afterEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM ext_login_credentials"),
    db.prepare("DELETE FROM ext_auth_throttle"),
    db.prepare("DELETE FROM channels WHERE id = ?").bind(CHANNEL_ID),
    db.prepare("DELETE FROM settings WHERE category = 'webGlobalSettings'"),
    db.prepare("DELETE FROM settings WHERE category = 'app_login_methods'"),
    db.prepare("DELETE FROM ext_app_about_info"),
  ]);
  await deleteCachedJson(APP_LOGIN_METHODS_CACHE);
});

describe("App login (ticket 12)", () => {
  it("signs in by username and issues an mflc_ login credential", async () => {
    await createAccount({account: "appuser", name: "App User", password: "secret1"});

    const payload = await appLogin(env, appRequest("/api/AppBookRequest/login"), await withCaptcha({
      UserName: "appuser",
      Password: "secret1",
    })) as Record<string, unknown>;

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
    const first = await appLogin(env, appRequest("/api/AppBookRequest/login"), await withCaptcha({
      UserName: "reuse",
      Password: "secret1",
    })) as Record<string, unknown>;
    const second = await appLogin(env, appRequest("/api/AppBookRequest/login"), await withCaptcha({
      UserName: "reuse",
      Password: "secret1",
    })) as Record<string, unknown>;
    expect(second.Token).toBe(first.Token);
  });

  it("signs in by email address", async () => {
    await createAccount({account: "Mail@Example.com", name: "Mail", password: "secret1"});

    const payload = await appLogin(env, appRequest("/api/AppBookRequest/login"), await withCaptcha({
      UserName: "mail@example.com",
      Password: "secret1",
    })) as Record<string, unknown>;

    expect(typeof payload.Token).toBe("string");
    expect(payload.Account).toBe("mail@example.com");
  });

  it("rejects a wrong password without leaking account existence", async () => {
    await createAccount({account: "gooduser", name: "Good", password: "secret1"});
    const wrong = await appLogin(env, appRequest("/api/AppBookRequest/login"), await withCaptcha({
      UserName: "gooduser",
      Password: "wrong-password",
    }));
    expect(wrong).toBe("登录失败,请检查账号密码");

    const unknown = await appLogin(env, appRequest("/api/AppBookRequest/login"), await withCaptcha({
      UserName: "nobody-here",
      Password: "whatever1",
    }));
    expect(unknown).toBe("登录失败,请检查账号密码");
  });

  it("returns the legacy empty-input message for missing fields", async () => {
    expect(await appLogin(env, appRequest("/api/AppBookRequest/login"), null))
      .toBe("请检查账号密码");
    expect(await appLogin(env, appRequest("/api/AppBookRequest/login"), {
      UserName: "x",
    })).toBe("请检查账号密码");
  });

  it("rejects a banned account at login without issuing a credential", async () => {
    await createAccount({account: "banneduser", name: "Banned", password: "secret1"});
    const bannedId = (await db.prepare(
      'SELECT id FROM "auth_user" WHERE username = ?',
    ).bind("banneduser").first<{id: string}>())?.id ?? "";
    await db.prepare(
      'UPDATE "auth_user" SET banned = 1 WHERE id = ?',
    ).bind(bannedId).run();

    const denied = await appLogin(env, appRequest("/api/AppBookRequest/login"), await withCaptcha({
      UserName: "banneduser",
      Password: "secret1",
    }));
    expect(denied).toBe("登录失败,请检查账号密码");
    expect(await listLoginCredentialsForUser(db, bannedId)).toHaveLength(0);
  });
});

describe("App login methods config (ADR-0050)", () => {
  async function save(
    patch: Record<string, boolean>,
  ): Promise<void> {
    const result = await saveLoginMethodsConfig(
      new FeedDb(env, appRequest("/api/AppBookRequest/login")),
      patch,
      "u_appauth_admin",
    );
    expect(result).toEqual({ok: true});
  }

  it("rejects everything without any checks when the master switch is off", async () => {
    await save({loginEnabled: false});
    // 空请求体也返回总闸文案——总闸判定先于一切检查（ADR-0050 D7）。
    const empty = await appLogin(env, appRequest("/api/AppBookRequest/login"), {});
    expect(empty).toBe("登录功能开发中,敬请期待");
    // 带完整账号与有效验证码同样被总闸拦下，不进入后续链路。
    const full = await appLogin(env, appRequest("/api/AppBookRequest/login"), await withCaptcha({
      UserName: "anyone",
      Password: "whatever",
    }));
    expect(full).toBe("登录功能开发中,敬请期待");
  });

  it("keeps requiring captcha when no config row exists (default)", async () => {
    await createAccount({account: "defuser", name: "Def", password: "secret1"});
    const noCaptcha = await appLogin(env, appRequest("/api/AppBookRequest/login"), {
      UserName: "defuser",
      Password: "secret1",
    });
    expect(noCaptcha).toBe("请输入图形验证码");
  });

  it("rejects the whole method before captcha when accountPassword is disabled", async () => {
    await createAccount({account: "offuser", name: "Off", password: "secret1"});
    await save({accountPasswordEnabled: false});
    // 不带验证码提交：返回停用文案而非「请输入图形验证码」，证明方式判定在前。
    const disabled = await appLogin(env, appRequest("/api/AppBookRequest/login"), {
      UserName: "offuser",
      Password: "secret1",
    });
    expect(disabled).toBe("该登录方式已停用");
  });

  it("skips the captcha step entirely when captcha is disabled", async () => {
    await createAccount({account: "nocap", name: "NoCap", password: "secret1"});
    await save({captchaEnabled: false});
    const payload = await appLogin(env, appRequest("/api/AppBookRequest/login"), {
      UserName: "nocap",
      Password: "secret1",
    }) as Record<string, unknown>;
    expect(typeof payload.Token).toBe("string");
    expect(payload.Token as string).toMatch(/^mflc_/u);
  });

  it("returns to the default behaviour after re-enabling both switches", async () => {
    await createAccount({account: "reuser", name: "Re", password: "secret1"});
    await save({captchaEnabled: false});
    await save({captchaEnabled: true});
    const needCaptcha = await appLogin(env, appRequest("/api/AppBookRequest/login"), {
      UserName: "reuser",
      Password: "secret1",
    });
    expect(needCaptcha).toBe("请输入图形验证码");
  });
});

describe("App login throttle (ADR-0011 D1 / ticket 12 限流)", () => {
  const LOGIN_URL = "https://app.example.com/api/AppBookRequest/login";

  function loginRequest(ip: string): Request {
    return new Request(LOGIN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": ip,
      },
      body: JSON.stringify({UserName: "throttle-probe", Password: "irrelevant"}),
    });
  }

  it("returns 429 on the 6th attempt from one IP within the 60s window", async () => {
    const ip = "203.0.113.77";
    // 隔离：清掉该 IP 的限流计数，避免跨用例累加。
    await db
      .prepare("DELETE FROM ext_auth_throttle WHERE key = ?")
      .bind(`auth:${ip}:/api/AppBookRequest/login`)
      .run();

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await appLoginPost({request: loginRequest(ip)} as never);
      statuses.push(res.status);
    }

    // 前 5 次穿透限流走到登录逻辑（返回 200 信封），第 6 次被限流返回 429。
    expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
    expect(statuses.filter((s) => s === 429).length).toBe(1);

    // 窗口内继续请求仍 429，且带 retry-after 头。
    const throttled = await appLoginPost({request: loginRequest(ip)} as never);
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).not.toBeNull();
  });

  it("does not throttle when the client address is absent", async () => {
    const res = await appLoginPost({
      request: new Request(LOGIN_URL, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({UserName: "x", Password: "y"}),
      }),
    } as never);
    // 无 IP 时跳过 IP 维度（B13 决策），不会误拦（走登录逻辑返回 200 信封）。
    expect(res.status).not.toBe(429);
  });
});

describe("App site config (ticket 13)", () => {  it("getAboutInfo reads the ext_app_about_info table verbatim", async () => {
    await db.prepare("DELETE FROM ext_app_about_info").run();
    expect(await getAppAboutInfo(db)).toEqual([]);

    await db.prepare(
      "INSERT INTO ext_app_about_info (name, text) VALUES (?, ?), (?, ?)",
    ).bind("about_thks", "致谢内容", "app_updata_log", "更新日志|第二行").run();
    expect(await getAppAboutInfo(db)).toEqual([
      {name: "about_thks", text: "致谢内容"},
      {name: "app_updata_log", text: "更新日志|第二行"},
    ]);
  });

  it("pic captcha issues a signed PNG (IsCode=true)", async () => {
    const res = await getPicCaptchaGet({} as never);
    const body = (await res.json()) as {
      code: number;
      data: {ValidCodeBase64: string; ValidCodeReqNo: string; IsCode: boolean};
    };
    expect(body.code).toBe(200);
    expect(body.data.IsCode).toBe(true);
    // 纯 PNG base64（无 data URI 前缀），App 端 BitmapFactory 才能解。
    expect(body.data.ValidCodeBase64.startsWith("iVBORw0KGgo")).toBe(true);
    expect(body.data.ValidCodeReqNo).toMatch(/^\d+\.[A-Za-z0-9_-]+$/u);
  });
});

