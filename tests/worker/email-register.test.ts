import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {env} from "cloudflare:workers";

import FeedDb from "@/server/feed/FeedDb";
import {POST as emailCodeCheckout} from "@/pages/api/AppBookRequest/emailCodeCheckout";
import {POST as emailCodeGet} from "@/pages/api/AppBookRequest/emailCodeGet";
import {POST as emailRegister} from "@/pages/api/AppBookRequest/emailRegister";
import {POST as checkEmailRegistered} from "@/pages/api/AppBookRequest/checkEmailRegistered";
import {saveLoginMethodsConfig} from "@/server/app/login/config";
import {createMicrofeedAuth} from "@/server/auth/better-auth";
import {appLogin} from "@/server/tcm/app-auth";
import {deleteCachedJson, APP_LOGIN_METHODS_CACHE} from "@/server/cache/app-cache";
import {generateEmailOtp, hashOtp, storeOtp} from "@/server/tcm/email-otp";
import {
  GET as mailSettingsGet,
} from "@/pages/[adminPath]/ajax/mail-settings/index";
import {
  POST as mailSettingsSave,
} from "@/pages/[adminPath]/ajax/mail-settings/save";
import {readMailSettingsConfig} from "@/server/mail/mail-config";

/**
 * 邮箱验证码注册的端点行为（ADR §6.1 / §6.2「集成」）。
 *
 * 跑在真实 worker + 真实 D1 上（迁移全量应用），验证的是三件靠读源码看不出来的
 * 事：开关关闭时三个端点一致拒绝、`checkout` 预校验后验证码仍然可用、
 * 「邮箱已注册」不会把用户的验证码烧掉。
 */

const db = env.FEED_DB;
const ORIGIN = "https://feed.example.com";
const PASSWORD = "microfeed123";

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

function post(handler: unknown, url: string, body: unknown) {
  return (handler as (context: never) => Promise<Response>)({
    request: new Request(url, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify(body),
    }),
  } as never);
}

async function setRegisterEnabled(enabled: boolean): Promise<void> {
  const result = await saveLoginMethodsConfig(
    newDb(),
    {emailRegisterEnabled: enabled},
    "u_test_admin",
  );
  expect(result).toEqual({ok: true});
}

/** 直接写一条验证码，绕过发码端点（发码会真发信，测试环境无 Resend 密钥）。 */
async function seedOtp(email: string): Promise<string> {
  const code = generateEmailOtp();
  await storeOtp(env.FEED_DB, email, "register", await hashOtp(code, env.BETTER_AUTH_SECRET));
  return code;
}

async function countOtp(email: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS total FROM ext_email_otp WHERE email = ?")
    .bind(email)
    .first<{total: number}>();
  return row?.total ?? 0;
}

afterEach(async () => {
  await db.prepare("DELETE FROM ext_email_otp").run();
  await db.prepare("DELETE FROM settings WHERE category = 'app_login_methods'").run();
  await db.prepare("DELETE FROM settings WHERE category = 'mail_settings'").run();
  await deleteCachedJson(APP_LOGIN_METHODS_CACHE);
});

beforeEach(async () => {
  await deleteCachedJson(APP_LOGIN_METHODS_CACHE);
});

describe("开关关闭时三个端点一致拒绝", () => {
  it("checkout 与 register 都回「邮箱注册暂未开放」", async () => {
    await setRegisterEnabled(false);

    const checkout = await post(
      emailCodeCheckout,
      `${ORIGIN}/api/AppBookRequest/emailCodeCheckout`,
      {email: "reader@example.com", code: "123456"},
    );
    expect((await checkout.json() as {data: unknown}).data).toBe("邮箱注册暂未开放");

    const register = await post(
      emailRegister,
      `${ORIGIN}/api/AppBookRequest/emailRegister`,
      {email: "reader@example.com", code: "123456", password: PASSWORD},
    );
    expect((await register.json() as {data: unknown}).data).toBe("邮箱注册暂未开放");
  });
});

describe("发码端点对已注册邮箱早期拒绝", () => {
  beforeEach(async () => {
    await setRegisterEnabled(true);
  });

  it("已注册邮箱发码即回「该邮箱已注册」，且不落 OTP 行", async () => {
    // 先建一个真实账号（走 emailRegister，用种子验证码）
    const email = "existing-early@example.com";
    const code = await seedOtp(email);
    const created = await post(emailRegister, `${ORIGIN}/api/AppBookRequest/emailRegister`, {
      email,
      code,
      password: PASSWORD,
    });
    expect((await created.json() as {data: unknown}).data).toEqual({});

    // 再次对同一邮箱发码：早期检查应在生成/发送前拒绝，不发码。
    const response = await post(
      emailCodeGet,
      `${ORIGIN}/api/AppBookRequest/emailCodeGet`,
      {email, purpose: "register"},
    );
    expect((await response.json() as {data: unknown}).data).toBe("该邮箱已注册");

    // 该邮箱没有新增 OTP 行（早期检查在 storeOtp 之前）。
    expect(await countOtp(email)).toBe(0);
  });

  it("已注册邮箱校验（checkout）也回「该邮箱已注册」", async () => {
    const email = "existing-checkout@example.com";
    const code = await seedOtp(email);
    await post(emailRegister, `${ORIGIN}/api/AppBookRequest/emailRegister`, {
      email,
      code,
      password: PASSWORD,
    });

    // 该邮箱此时没有有效验证码（已被 register 消费），但早期检查应先命中：
    // 需要先补一条 OTP 才能走到「已注册」判断。
    const second = await seedOtp(email);
    const response = await post(
      emailCodeCheckout,
      `${ORIGIN}/api/AppBookRequest/emailCodeCheckout`,
      {email, code: second},
    );
    expect((await response.json() as {data: unknown}).data).toBe("该邮箱已注册");
  });

  it("未注册邮箱发码不受「已注册」误判", async () => {
    const email = "fresh-early@example.com";
    const response = await post(
      emailCodeGet,
      `${ORIGIN}/api/AppBookRequest/emailCodeGet`,
      {email, purpose: "register"},
    );
    const data = (await response.json() as {data: unknown}).data;
    // 未注册邮箱走正常链路：生成 OTP → 尝试发信（测试环境无 Resend 密钥，回发送失败）。
    // 关键断言是它不被误判成「该邮箱已注册」。
    expect(data).not.toBe("该邮箱已注册");
  });
});

describe("checkout 只预校验，消费权在 register", () => {
  beforeEach(async () => {
    await setRegisterEnabled(true);
  });

  it("checkout 通过后验证码仍然留在库里", async () => {
    const email = "precheck@example.com";
    const code = await seedOtp(email);

    const response = await post(
      emailCodeCheckout,
      `${ORIGIN}/api/AppBookRequest/emailCodeCheckout`,
      {email, code},
    );
    expect((await response.json() as {data: unknown}).data).toEqual({ok: true});

    // 这一条是本次修复的核心：预校验若删行，后面的 register 必然拿不到验证码。
    expect(await countOtp(email)).toBe(1);
  });

  it("checkout 可以重复调用，同一个码一直有效", async () => {
    const email = "repeat@example.com";
    const code = await seedOtp(email);

    for (let i = 0; i < 2; i += 1) {
      const response = await post(
        emailCodeCheckout,
        `${ORIGIN}/api/AppBookRequest/emailCodeCheckout`,
        {email, code},
      );
      expect((await response.json() as {data: unknown}).data).toEqual({ok: true});
    }
    expect(await countOtp(email)).toBe(1);
  });

  it("错码累加 attempts 并回「验证码错误」", async () => {
    const email = "wrong@example.com";
    await seedOtp(email);

    const response = await post(
      emailCodeCheckout,
      `${ORIGIN}/api/AppBookRequest/emailCodeCheckout`,
      {email, code: "000000"},
    );
    expect((await response.json() as {data: unknown}).data).toBe("验证码错误");

    const row = await db
      .prepare("SELECT attempts FROM ext_email_otp WHERE email = ?")
      .bind(email)
      .first<{attempts: number}>();
    expect(row?.attempts).toBe(1);
  });
});

describe("register 建号", () => {
  beforeEach(async () => {
    await setRegisterEnabled(true);
  });

  it("注册成功后消费验证码、置 emailVerified、写入口令哈希", async () => {
    const email = "new-reader@example.com";
    const code = await seedOtp(email);

    const response = await post(
      emailRegister,
      `${ORIGIN}/api/AppBookRequest/emailRegister`,
      {email, code, password: PASSWORD},
    );
    expect((await response.json() as {data: unknown}).data).toEqual({});

    expect(await countOtp(email)).toBe(0);

    const user = await db
      .prepare("SELECT id, emailVerified, username FROM auth_user WHERE email = ?")
      .bind(email)
      .first<{id: string; emailVerified: number; username: string | null}>();
    expect(user?.emailVerified).toBe(1);
    expect(user?.username).toBe("new-reader");

    const account = await db
      .prepare("SELECT providerId FROM auth_account WHERE userId = ?")
      .bind(user?.id)
      .first<{providerId: string}>();
    expect(account?.providerId).toBe("credential");
  });

  it("注册出来的账号口令可被 better-auth 验证通过", async () => {
    const email = "can-login@example.com";
    const code = await seedOtp(email);
    await post(emailRegister, `${ORIGIN}/api/AppBookRequest/emailRegister`, {
      email,
      code,
      password: PASSWORD,
    });

    // 走默认实例（注册关闭）的登录原语：能通过说明 auth_user + auth_account
    // 两张表都被建号路径写对了，且 emailVerified 不是登录的阻塞条件。
    const request = new Request(ORIGIN);
    const signedIn = await createMicrofeedAuth(env, request).api.signInEmail({
      body: {email, password: PASSWORD},
      headers: request.headers,
    });
    expect(signedIn?.user?.email).toBe(email);
  });

  it("登录载荷的 Email 是注册邮箱（App 个人页靠它，缺了就永远是空）", async () => {
    const email = "login-payload@example.com";
    const code = await seedOtp(email);
    await post(emailRegister, `${ORIGIN}/api/AppBookRequest/emailRegister`, {
      email,
      code,
      password: PASSWORD,
    });

    // 图形验证码是「每次登录都要」的策略 A，这里只验载荷字段，直接关掉它。
    await saveLoginMethodsConfig(
      newDb(),
      {accountPasswordEnabled: true, captchaEnabled: false},
      "u_test_admin",
    );

    const payload = await appLogin(env as never, new Request(ORIGIN), {
      username: email,
      password: PASSWORD,
    });
    expect(typeof payload).toBe("object");

    const data = payload as Record<string, unknown>;
    // Android 侧 UserInfo 用 @SerializedName("Email") 接这个字段，再落 USER_INFO.EMAIL
    // 列；个人页没有别的邮箱来源，这条断了就是「登录成功但邮箱一栏永远空」。
    expect(data.Email).toBe(email);
    expect(data.Account).toBe(email);
    expect(data.UserName).toBe("login-payload");
    expect(typeof data.Token).toBe("string");
  });

  it("重复注册时回「该邮箱已注册」，且不烧掉验证码", async () => {
    const email = "dup@example.com";
    const first = await seedOtp(email);
    const created = await post(emailRegister, `${ORIGIN}/api/AppBookRequest/emailRegister`, {
      email,
      code: first,
      password: PASSWORD,
    });
    expect((await created.json() as {data: unknown}).data).toEqual({});

    const second = await seedOtp(email);
    const response = await post(
      emailRegister,
      `${ORIGIN}/api/AppBookRequest/emailRegister`,
      {email, code: second, password: PASSWORD},
    );
    expect((await response.json() as {data: unknown}).data).toBe("该邮箱已注册");

    // 用户改用登录即可，不需要重新收码——验证码必须还在。
    expect(await countOtp(email)).toBe(1);
  });

  it("同一个验证码只能建一次号", async () => {
    const email = "once@example.com";
    const code = await seedOtp(email);
    const first = await post(emailRegister, `${ORIGIN}/api/AppBookRequest/emailRegister`, {
      email,
      code,
      password: PASSWORD,
    });
    expect((await first.json() as {data: unknown}).data).toEqual({});

    await db.prepare("DELETE FROM auth_user WHERE email = ?").bind(email).run();
    const second = await post(emailRegister, `${ORIGIN}/api/AppBookRequest/emailRegister`, {
      email,
      code,
      password: PASSWORD,
    });
    expect((await second.json() as {data: unknown}).data).toBe("验证码无效或已过期");
  });

  it("口令过短时回长度文案，且不消费验证码", async () => {
    const email = "short@example.com";
    const code = await seedOtp(email);
    const response = await post(emailRegister, `${ORIGIN}/api/AppBookRequest/emailRegister`, {
      email,
      code,
      password: "123",
    });
    expect((await response.json() as {data: unknown}).data).toBe("密码长度不足6位");
    expect(await countOtp(email)).toBe(1);
  });

  it("邮箱形态不合法时回「邮箱格式不正确」", async () => {
    const response = await post(emailRegister, `${ORIGIN}/api/AppBookRequest/emailRegister`, {
      email: "not-an-email",
      code: "123456",
      password: PASSWORD,
    });
    expect((await response.json() as {data: unknown}).data).toBe("邮箱格式不正确");
  });
});

describe("checkEmailRegistered 失焦检查端点", () => {
  beforeEach(async () => {
    await setRegisterEnabled(true);
  });

  it("已注册邮箱回「该邮箱已注册」", async () => {
    const email = "check-existing@example.com";
    const code = await seedOtp(email);
    const created = await post(emailRegister, `${ORIGIN}/api/AppBookRequest/emailRegister`, {
      email,
      code,
      password: PASSWORD,
    });
    expect((await created.json() as {data: unknown}).data).toEqual({});

    const response = await post(
      checkEmailRegistered,
      `${ORIGIN}/api/AppBookRequest/checkEmailRegistered`,
      {email},
    );
    expect((await response.json() as {data: unknown}).data).toBe("该邮箱已注册");
  });

  it("未注册邮箱回空 Bean（成功形态，App 静默）", async () => {
    const response = await post(
      checkEmailRegistered,
      `${ORIGIN}/api/AppBookRequest/checkEmailRegistered`,
      {email: "check-fresh@example.com"},
    );
    expect((await response.json() as {data: unknown}).data).toEqual({});
  });

  it("邮箱形态不合法时回「邮箱格式不正确」", async () => {
    const response = await post(
      checkEmailRegistered,
      `${ORIGIN}/api/AppBookRequest/checkEmailRegistered`,
      {email: "not-an-email"},
    );
    expect((await response.json() as {data: unknown}).data).toBe("邮箱格式不正确");
  });

  it("开关关闭时回「邮箱注册暂未开放」（不泄露注册状态）", async () => {
    await setRegisterEnabled(false);
    // 即使该邮箱已注册，关闭时也不能回答「已注册」——kill-switch 语义优先。
    const email = "check-gated@example.com";
    const code = await seedOtp(email);
    await post(emailRegister, `${ORIGIN}/api/AppBookRequest/emailRegister`, {
      email,
      code,
      password: PASSWORD,
    });

    const response = await post(
      checkEmailRegistered,
      `${ORIGIN}/api/AppBookRequest/checkEmailRegistered`,
      {email},
    );
    expect((await response.json() as {data: unknown}).data).toBe("邮箱注册暂未开放");
  });
});

describe("后台邮件设置端点", () => {
  const READ_URL = `${ORIGIN}/admin/ajax/mail-settings/`;
  const SAVE_URL = `${ORIGIN}/admin/ajax/mail-settings/save`;

  it("无会话读取被拒", async () => {
    const response = await mailSettingsGet({
      locals: locals("u_nobody", []),
      request: new Request(READ_URL),
    } as never);
    expect(response.status).toBe(403);
  });

  it("保存后 readMailSettingsConfig 读到新值", async () => {
    const saved = await mailSettingsSave({
      locals: locals("u_admin", ["system:mail-settings:manage"]),
      request: new Request(SAVE_URL, {
        method: "POST",
        headers: {"content-type": "application/json", origin: ORIGIN},
        body: JSON.stringify({
          patch: {
            fromAddress: "kf@example.com",
            fromName: "中医百科",
            subjectTemplate: "【联调】{{code}} 是您的验证码",
            bodyTemplate: "<p>{{code}} / {{expireMinutes}}</p>",
          },
        }),
      }),
    } as never);
    expect(saved.status).toBe(200);

    const config = await readMailSettingsConfig(newDb());
    expect(config.fromAddress).toBe("kf@example.com");
    expect(config.subjectTemplate).toBe("【联调】{{code}} 是您的验证码");
    expect(config.updatedBy).toBe("u_admin");
    expect(config.updatedAtMs).toBeGreaterThan(0);
  });

  it("非字符串字段回 400，不动库", async () => {
    const response = await mailSettingsSave({
      locals: locals("u_admin", ["system:mail-settings:manage"]),
      request: new Request(SAVE_URL, {
        method: "POST",
        headers: {"content-type": "application/json", origin: ORIGIN},
        body: JSON.stringify({patch: {fromAddress: 42}}),
      }),
    } as never);
    expect(response.status).toBe(400);
    expect(await readMailSettingsConfig(newDb())).toEqual({
      fromAddress: "",
      fromName: "",
      subjectTemplate: "",
      bodyTemplate: "",
      updatedAtMs: 0,
      updatedBy: null,
    });
  });

  it("读取端点不回传密钥，只给布尔", async () => {
    const response = await mailSettingsGet({
      locals: locals("u_reader", ["system:mail-settings:read"]),
      request: new Request(READ_URL),
    } as never);
    const body = await response.json() as {
      delivery: Record<string, unknown>;
    };
    expect(typeof body.delivery.apiKeyConfigured).toBe("boolean");
    expect(JSON.stringify(body)).not.toContain("re_");
  });
});
