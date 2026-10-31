// QQ 第三方登录（ADR-0013，见 AndroidProject-old 仓 docs/adr/0013-qq-third-party-login.md；
// 本期仅 QQ；微信返回「暂不支持」）的后端单元测试。
//
// 三件事是这一组用例真正要守住的：
//  1. 旁路受 host 约束——`QQ_OAUTH_DEV_MOCK="1"` 只在 localhost / 局域网地址生效，
//     生产域名上即使变量被置成 1 也走真实校验。
//  2. 业务闸恒参与——dev-mock 只跳过腾讯校验，不跳过 loginEnabled / qqEnabled / 密钥存在。
//  3. 身份以腾讯为准——真实模式下忽略客户端自报 openid，绑定腾讯返回的权威 openid。

import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {env} from "cloudflare:workers";

import {verifyLoginCredentialToken} from "@/server/auth/login-credentials";
import FeedDb from "@/server/feed/FeedDb";
import {appThirdPartyLogin} from "@/server/tcm/app-third-party";
import {POST as thirdPartyLoginPost} from "@/pages/api/AppBookRequest/thirdPartyLogin";
import {saveLoginMethodsConfig} from "@/server/app/login/config";
import {
  APP_LOGIN_METHODS_CACHE,
  deleteCachedJson,
} from "@/server/cache/app-cache";

const db = env.FEED_DB;
/** 生产形态的域名：不是本机、不是私有网段，旁路必须在这里失效。 */
const ORIGIN = "https://feed.example.com";
/** 本机联调形态：旁路在这里才生效。 */
const LOCAL_ORIGIN = "http://localhost:8787";
const ROUTE = "/api/AppBookRequest/thirdPartyLogin";

// 备份 .dev.vars 注入的原始值，afterEach 还原，避免污染其它测试文件共享的 env。
const ORIGINAL_DEV_MOCK = env.QQ_OAUTH_DEV_MOCK;
const ORIGINAL_APP_ID = env.QQ_APP_ID;
const ORIGINAL_APP_SECRET = env.QQ_APP_SECRET;

function appRequest(url: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${url}`, init);
}

function localRequest(url: string, init: RequestInit = {}): Request {
  return new Request(`${LOCAL_ORIGIN}${url}`, init);
}

/** 写后台「登录管理」开关（settings 表 + 清缓存，与 admin 保存路径一致）。 */
async function saveMethods(patch: {
  loginEnabled?: boolean;
  qqEnabled?: boolean;
}): Promise<void> {
  const result = await saveLoginMethodsConfig(
    new FeedDb(env, appRequest(ROUTE)),
    patch,
    "u_thirdparty_test",
  );
  expect(result).toEqual({ok: true});
  await deleteCachedJson(APP_LOGIN_METHODS_CACHE);
}

/** 模拟腾讯：/oauth2.0/me 返回 openid+client_id；get_user_info 返回昵称/头像。 */
function qqMockFetcher(
  openid: string,
  clientId: string,
  nickname = "",
  avatar = "",
): typeof fetch {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes("/oauth2.0/me")) {
      return new Response(JSON.stringify({openid, client_id: clientId}), {status: 200});
    }
    if (url.includes("get_user_info")) {
      return new Response(
        JSON.stringify({ret: 0, nickname, figureurl_qq_2: avatar}),
        {status: 200},
      );
    }
    return new Response("{}", {status: 404});
  };
}

/** 守门 fetcher：一旦被调用就说明「本不该请求腾讯」的分支漏了。 */
function guardFetcher(): {fetcher: typeof fetch; called: () => boolean} {
  let called = false;
  const fetcher = (async (): Promise<Response> => {
    called = true;
    return new Response("{}");
  }) as typeof fetch;
  return {fetcher, called: () => called};
}

async function clearTables(): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM ext_user_oauth"),
    db.prepare("DELETE FROM ext_login_credentials"),
    db.prepare("DELETE FROM auth_account"),
    db.prepare("DELETE FROM auth_session"),
    db.prepare("DELETE FROM ext_user_security"),
    db.prepare("DELETE FROM ext_user_roles"),
    db.prepare("DELETE FROM ext_user_devices"),
    db.prepare("DELETE FROM ext_auth_throttle"),
    db.prepare('DELETE FROM "auth_user"'),
    db.prepare("DELETE FROM settings WHERE category = 'app_login_methods'"),
  ]);
  await deleteCachedJson(APP_LOGIN_METHODS_CACHE);
}

beforeEach(async () => {
  await clearTables();
});

afterEach(async () => {
  await clearTables();
  env.QQ_OAUTH_DEV_MOCK = ORIGINAL_DEV_MOCK;
  env.QQ_APP_ID = ORIGINAL_APP_ID;
  env.QQ_APP_SECRET = ORIGINAL_APP_SECRET;
});

describe("QQ 第三方登录（dev-mock 旁路，ADR-0013）", () => {
  beforeEach(async () => {
    env.QQ_OAUTH_DEV_MOCK = "1";
    // 密钥位必须有值（占位即可）：业务闸里的 fail-closed 对旁路同样生效。
    env.QQ_APP_ID = "dev-app-id-placeholder";
    env.QQ_APP_SECRET = "dev-secret-placeholder";
    await saveMethods({loginEnabled: true, qqEnabled: true});
  });

  it("信任客户端 openid：首次登录建号并签发 mflc_ 凭证", async () => {
    const payload = await appThirdPartyLogin(
      env,
      localRequest(ROUTE),
      {platform: "qq", openid: "OPENID_A", accessToken: "any-token-does-not-matter"},
    ) as Record<string, unknown>;

    expect(typeof payload.Token).toBe("string");
    expect(payload.Token as string).toMatch(/^mflc_/u);
    expect(payload.Account).toBe("qq_OPENID_A");
    // dev-mock 昵称占位：QQ_<openid 前 8 位>。
    expect(payload.UserName).toBe("QQ_OPENID_A");
    expect(payload.Name).toBe("QQ_OPENID_A");
    expect(payload.Img).toBe("");

    // 凭证可解析回该用户（Bearer 走 decideLoginCredentialApiRequest）。
    const verified = await verifyLoginCredentialToken(db, payload.Token as string);
    expect(verified).not.toBeNull();

    // ext_user_oauth 绑定了 (qq, OPENID_A) → 该用户。
    const oauth = await db.prepare(
      "SELECT user_id FROM ext_user_oauth WHERE provider = 'qq' AND openid = ? LIMIT 1",
    ).bind("OPENID_A").first<{user_id: string}>();
    expect(oauth).not.toBeNull();
    expect(oauth!.user_id).toBe(verified!.userId);

    // 写入数据库的账号：email / username 由 openid 派生，唯一可定位。
    const user = await db.prepare(
      'SELECT email, username FROM "auth_user" WHERE id = ? LIMIT 1',
    ).bind(verified!.userId).first<{email: string; username: string}>();
    expect(user!.email).toBe("qq_OPENID_A@oauth.local");
    expect(user!.username).toBe("qq_openid_a");

    // ADR-0014 D8/D9：注册来源记成 'qq'，且占位邮箱不可发信。
    const attrs = await db.prepare(
      'SELECT signup_source, email_usable FROM "auth_user" WHERE id = ? LIMIT 1',
    ).bind(verified!.userId).first<{email_usable: number; signup_source: string}>();
    expect(attrs!.signup_source).toBe("qq");
    expect(attrs!.email_usable).toBe(0);
    // 下发给客户端的是「能不能收信」，不是来源（`signup_source` 按下发范围决议不下发）。
    expect(payload.EmailUsable).toBe(0);
    expect(payload.signup_source).toBeUndefined();
  });

  it("同 openid 重复登录复用同一用户与凭证（幂等）", async () => {
    const body = {platform: "qq", openid: "OPENID_C", accessToken: "t"};
    const first = await appThirdPartyLogin(env, localRequest(ROUTE), body) as Record<string, unknown>;
    const second = await appThirdPartyLogin(env, localRequest(ROUTE), body) as Record<string, unknown>;

    expect(second.Token).toBe(first.Token);
    expect(second.Account).toBe("qq_OPENID_C");

    const oauthRows = await db.prepare(
      "SELECT COUNT(*) AS c FROM ext_user_oauth WHERE provider = 'qq' AND openid = ?",
    ).bind("OPENID_C").first<{c: number}>();
    expect(oauthRows!.c).toBe(1);
    const users = await db.prepare(
      'SELECT COUNT(*) AS c FROM "auth_user" WHERE email = ?',
    ).bind("qq_OPENID_C@oauth.local").first<{c: number}>();
    expect(users!.c).toBe(1);
  });

  it("微信登录返回「暂不支持」", async () => {
    const result = await appThirdPartyLogin(
      env,
      localRequest(ROUTE),
      {platform: "wechat", openid: "W", accessToken: "t"},
    );
    expect(result).toBe("暂不支持");
  });

  it("platform 为空 → 「参数缺失，请重试」（不归入「暂不支持」）", async () => {
    const result = await appThirdPartyLogin(
      env,
      localRequest(ROUTE),
      {openid: "W", accessToken: "t"},
    );
    expect(result).toBe("参数缺失，请重试");
  });

  it("旁路不绕过业务闸：qqEnabled=false 仍拒绝", async () => {
    await saveMethods({qqEnabled: false});
    const result = await appThirdPartyLogin(
      env,
      localRequest(ROUTE),
      {platform: "qq", openid: "GATED", accessToken: "t"},
    );
    expect(result).toBe("该登录方式已停用");

    const rows = await db.prepare('SELECT COUNT(*) AS c FROM "auth_user"')
      .first<{c: number}>();
    expect(rows!.c).toBe(0);
  });

  it("旁路不绕过业务闸：loginEnabled=false 仍拒绝", async () => {
    await saveMethods({loginEnabled: false});
    const result = await appThirdPartyLogin(
      env,
      localRequest(ROUTE),
      {platform: "qq", openid: "GATED", accessToken: "t"},
    );
    expect(result).toBe("登录功能开发中,敬请期待");
  });

  it("非本机 host 上旁路失效：变量置 1 也走真实校验", async () => {
    // 关键安全属性：生产域名 + QQ_OAUTH_DEV_MOCK="1" 不能变成「信任客户端 openid」。
    const fetcher = qqMockFetcher("OPENID_REAL", "someone-elses-app", "", "");
    const result = await appThirdPartyLogin(
      env,
      appRequest(ROUTE),
      {platform: "qq", openid: "CLIENT_CLAIMED", accessToken: "tok"},
      fetcher,
    );
    expect(result).toBe("QQ 校验失败");

    const rows = await db.prepare('SELECT COUNT(*) AS c FROM "auth_user"')
      .first<{c: number}>();
    expect(rows!.c).toBe(0);
  });

  it("已有同名 auth_user（无 oauth 绑定）时链接而非新建，并刷新资料", async () => {
    // 预先存在一个 email/username 与本应新建账号相撞的用户（模拟历史账号 /
    // 并发首登的另一胜出者）。createQqUser 的 INSERT OR IGNORE 会被忽略，
    // 走回查分支绑定既有用户——这是并发首登幂等的关键路径。
    const preExistingId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.prepare(
      'INSERT INTO "auth_user" ' +
        "(id, name, email, emailVerified, image, createdAt, updatedAt, role, username, displayUsername, banned) " +
        "VALUES (?, ?, ?, 1, NULL, ?, ?, 'user', ?, NULL, 0)",
    ).bind(
      preExistingId,
      "legacy",
      "qq_OPENID_B@oauth.local",
      now,
      now,
      "qq_openid_b",
    ).run();

    const payload = await appThirdPartyLogin(
      env,
      localRequest(ROUTE),
      {platform: "qq", openid: "OPENID_B", accessToken: "t"},
    ) as Record<string, unknown>;

    expect(payload.Account).toBe("qq_OPENID_B");
    const verified = await verifyLoginCredentialToken(db, payload.Token as string);
    expect(verified!.userId).toBe(preExistingId); // 链接到既有用户，未新建
    const oauth = await db.prepare(
      "SELECT user_id FROM ext_user_oauth WHERE provider = 'qq' AND openid = ? LIMIT 1",
    ).bind("OPENID_B").first<{user_id: string}>();
    expect(oauth!.user_id).toBe(preExistingId);

    // 链接路径也要刷昵称，否则历史账号永远停在旧名。
    const linked = await db.prepare(
      'SELECT name FROM "auth_user" WHERE id = ? LIMIT 1',
    ).bind(preExistingId).first<{name: string}>();
    expect(linked!.name).toBe("QQ_OPENID_B");
  });

  it("openid 只差大小写（username 冲突、email 不冲突）时链接到既有账号，不绑出幽灵 user_id", async () => {
    // `INSERT OR IGNORE` 会连带吞掉 username 唯一冲突：email 保留原始大小写、
    // username 走 toLowerCase()，同一 openid 换头大小写就变成「email 是新的、
    // username 撞了」。若回查只按 email，会查不到 → 把 openid 绑到一个没插进去的
    // id 上 → 该 openid 之后每次登录都「登录失败」，且不自愈。
    const preExistingId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.prepare(
      'INSERT INTO "auth_user" ' +
        "(id, name, email, emailVerified, image, createdAt, updatedAt, role, username, displayUsername, banned) " +
        "VALUES (?, ?, ?, 1, NULL, ?, ?, 'user', ?, NULL, 0)",
    ).bind(
      preExistingId,
      "小写那次登录",
      "qq_openid_case@oauth.local",
      now,
      now,
      "qq_openid_case",
    ).run();

    const payload = await appThirdPartyLogin(
      env,
      localRequest(ROUTE),
      {platform: "qq", openid: "OPENID_CASE", accessToken: "t"},
    ) as Record<string, unknown>;

    expect(payload.Account).toBe("qq_OPENID_CASE");
    const verified = await verifyLoginCredentialToken(db, payload.Token as string);
    expect(verified!.userId).toBe(preExistingId); // 复用既有账号，没有建出第二行

    const count = await db.prepare(
      'SELECT COUNT(*) AS c FROM "auth_user" WHERE username = ?',
    ).bind("qq_openid_case").first<{c: number}>();
    expect(count!.c).toBe(1);

    const oauth = await db.prepare(
      "SELECT user_id FROM ext_user_oauth WHERE provider = 'qq' AND openid = ? LIMIT 1",
    ).bind("OPENID_CASE").first<{user_id: string}>();
    expect(oauth!.user_id).toBe(preExistingId);
    // 关键：绑定指向的用户必须真实存在（幽灵绑定的判据）。
    const real = await db.prepare('SELECT id FROM "auth_user" WHERE id = ? LIMIT 1')
      .bind(oauth!.user_id).first<{id: string}>();
    expect(real).not.toBeNull();
  });

  it("username 被非本 openid 的账号占用时拒绝，不把登录态签给他人", async () => {
    // username 是全局命名空间：真人账号可能恰好叫 `qq_<openid>`。若回查只看
    // username 不看「是不是同一 openid 派生」，就会把这张 QQ 的登录态签到别人账上。
    const strangerId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.prepare(
      'INSERT INTO "auth_user" ' +
        "(id, name, email, emailVerified, image, createdAt, updatedAt, role, username, displayUsername, banned) " +
        "VALUES (?, ?, ?, 1, NULL, ?, ?, 'user', ?, NULL, 0)",
    ).bind(
      strangerId,
      "无关账号",
      "someone@example.com",
      now,
      now,
      "qq_openid_evil",
    ).run();

    await expect(appThirdPartyLogin(
      env,
      localRequest(ROUTE),
      {platform: "qq", openid: "OPENID_EVIL", accessToken: "t"},
    // 文案以 `createQqUser` 的抛错为准（ADR-0015 把措辞收敛成「占位标识被占用」，
    // 因为被占的是 email/username 这对占位标识，不是 openid 本身）。
    )).rejects.toThrow(/占位标识被非本 openid 的行占用/u);

    // 既没有新账号，也没有把 openid 绑到无关账号上。
    const oauth = await db.prepare(
      "SELECT COUNT(*) AS c FROM ext_user_oauth WHERE provider = 'qq'",
    ).first<{c: number}>();
    expect(oauth!.c).toBe(0);
    const stranger = await db.prepare(
      'SELECT email, name FROM "auth_user" WHERE id = ? LIMIT 1',
    ).bind(strangerId).first<{email: string; name: string}>();
    expect(stranger!.email).toBe("someone@example.com");
    expect(stranger!.name).toBe("无关账号"); // 未被 refreshProfile 改写
  });

  it("路由层：dev-mock 下 POST 返回 200 且 data 内含 mflc_ 凭证", async () => {
    const res = await thirdPartyLoginPost({
      request: new Request(`${LOCAL_ORIGIN}${ROUTE}`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({platform: "qq", openid: "OPENID_ROUTE", accessToken: "t"}),
      }),
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json() as {code: number; data: Record<string, unknown>};
    expect(body.code).toBe(200);
    expect(typeof body.data.Token).toBe("string");
    expect(body.data.Token as string).toMatch(/^mflc_/u);
    expect(body.data.Account).toBe("qq_OPENID_ROUTE");
  });
});

describe("QQ 第三方登录（真实校验，mock 腾讯，ADR-0013）", () => {
  const TEST_APP_ID = "test-app-id-001";

  beforeEach(async () => {
    env.QQ_OAUTH_DEV_MOCK = "";
    env.QQ_APP_ID = TEST_APP_ID;
    env.QQ_APP_SECRET = "test-app-secret";
    await saveMethods({loginEnabled: true, qqEnabled: true});
  });

  it("校验通过：以腾讯返回的权威 openid 建号，昵称/头像取自腾讯", async () => {
    const fetcher = qqMockFetcher(
      "OPENID_REAL",
      TEST_APP_ID,
      "真实昵称",
      "https://avatar.example/2.jpg",
    );
    const payload = await appThirdPartyLogin(
      env,
      appRequest(ROUTE),
      {platform: "qq", openid: "CLIENT_LIED_OPENID", accessToken: "tok"},
      fetcher,
    ) as Record<string, unknown>;

    // 关键安全属性：后端以腾讯校验回的 openid 为准，忽略客户端自报。
    expect(payload.Account).toBe("qq_OPENID_REAL");
    expect(payload.UserName).toBe("真实昵称");
    expect(payload.Name).toBe("真实昵称");
    expect(payload.Img).toBe("https://avatar.example/2.jpg");

    const verified = await verifyLoginCredentialToken(db, payload.Token as string);
    expect(verified).not.toBeNull();

    const oauth = await db.prepare(
      "SELECT openid FROM ext_user_oauth WHERE provider = 'qq' AND user_id = ? LIMIT 1",
    ).bind(verified!.userId).first<{openid: string}>();
    expect(oauth!.openid).toBe("OPENID_REAL"); // 绑定的是权威 openid，不是客户端瞎报的
  });

  it("腾讯校验返回别家 client_id：拒绝", async () => {
    const fetcher = qqMockFetcher("OPENID_REAL", "evil-other-app", "", "");
    const result = await appThirdPartyLogin(
      env,
      appRequest(ROUTE),
      {platform: "qq", openid: "x", accessToken: "tok"},
      fetcher,
    );
    expect(result).toBe("QQ 校验失败");
  });

  it("后端 QQ_APP_ID 为逗号分隔允许清单：命中 debug AppID 即通过", async () => {
    // 多 AppID 形态：release 与 debug 是不同 AppID，后端用清单包含判断而非等值判断。
    env.QQ_APP_ID = "release-app-id,debug-app-id";
    const fetcher = qqMockFetcher("OPENID_REAL", "debug-app-id", "调试昵称", "");
    const payload = await appThirdPartyLogin(
      env,
      appRequest(ROUTE),
      {platform: "qq", openid: "x", accessToken: "tok"},
      fetcher,
    ) as Record<string, unknown>;
    expect(payload.Account).toBe("qq_OPENID_REAL"); // 仍以腾讯权威 openid 为准
    expect(payload.UserName).toBe("调试昵称");
  });

  it("D4：绑定后的真实账号不再被 QQ 昵称/头像覆盖（原值无备份，改不回去）", async () => {
    // 造一个真实邮箱账号，并把 openid 绑到它名下 —— 即 ADR-0014 绑定完成后的形态。
    const realId = "u_d4_real";
    await db.prepare(
      'INSERT INTO "auth_user" (id, name, email, emailVerified, createdAt, updatedAt, ' +
        'role, image, signup_source) VALUES (?, ?, ?, 1, ?, ?, \'user\', ?, \'email\')',
    ).bind(realId, "张真人", "real-d4@example.com", "2024-01-01", "2024-01-01",
      "https://a/mine.jpg").run();
    await db.prepare(
      "INSERT OR IGNORE INTO ext_user_oauth (provider, openid, user_id, created_at_ms) " +
        "VALUES ('qq', ?, ?, ?)",
    ).bind("OPENID_D4", realId, Date.now()).run();

    await appThirdPartyLogin(
      env,
      appRequest(ROUTE),
      {platform: "qq", openid: "x", accessToken: "tok"},
      qqMockFetcher("OPENID_D4", TEST_APP_ID, "QQ昵称", "https://a/qq.jpg"),
    );

    // 库里两列必须原封不动。
    const row = await db.prepare(
      'SELECT name, image FROM "auth_user" WHERE id = ? LIMIT 1',
    ).bind(realId).first<{name: string; image: string}>();
    expect(row!.name).toBe("张真人");
    expect(row!.image).toBe("https://a/mine.jpg");
  });

  it("再登刷新昵称/头像（资料不永远停在首登快照）", async () => {
    const first = await appThirdPartyLogin(
      env,
      appRequest(ROUTE),
      {platform: "qq", openid: "x", accessToken: "tok"},
      qqMockFetcher("OPENID_REFRESH", TEST_APP_ID, "旧昵称", "https://a/old.jpg"),
    ) as Record<string, unknown>;
    const userId = (await verifyLoginCredentialToken(db, first.Token as string))!.userId;

    const second = await appThirdPartyLogin(
      env,
      appRequest(ROUTE),
      {platform: "qq", openid: "x", accessToken: "tok"},
      qqMockFetcher("OPENID_REFRESH", TEST_APP_ID, "新昵称", "https://a/new.jpg"),
    ) as Record<string, unknown>;

    expect(second.UserName).toBe("新昵称");
    expect(second.Img).toBe("https://a/new.jpg");
    const row = await db.prepare(
      'SELECT name, image, updatedAt FROM "auth_user" WHERE id = ? LIMIT 1',
    ).bind(userId).first<{name: string; image: string; updatedAt: string}>();
    expect(row!.name).toBe("新昵称");
    expect(row!.image).toBe("https://a/new.jpg");
    expect(row!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it("业务闸：QQ 方式停用 → 「该登录方式已停用」", async () => {
    await saveMethods({qqEnabled: false});
    const fetcher = qqMockFetcher("OPENID_REAL", TEST_APP_ID, "", "");
    const result = await appThirdPartyLogin(
      env,
      appRequest(ROUTE),
      {platform: "qq", openid: "x", accessToken: "tok"},
      fetcher,
    );
    expect(result).toBe("该登录方式已停用");
  });

  it("业务闸：总闸关闭 → 「登录功能开发中,敬请期待」", async () => {
    await saveMethods({loginEnabled: false});
    const fetcher = qqMockFetcher("OPENID_REAL", TEST_APP_ID, "", "");
    const result = await appThirdPartyLogin(
      env,
      appRequest(ROUTE),
      {platform: "qq", openid: "x", accessToken: "tok"},
      fetcher,
    );
    expect(result).toBe("登录功能开发中,敬请期待");
  });

  it("缺 accessToken → 「参数缺失，请重试」", async () => {
    const result = await appThirdPartyLogin(
      env,
      appRequest(ROUTE),
      {platform: "qq", openid: "x"},
    );
    expect(result).toBe("参数缺失，请重试");
  });

  it("QQ_APP_ID/SECRET 缺失（fail-closed）拒绝且不调腾讯", async () => {
    env.QQ_APP_ID = "";
    env.QQ_APP_SECRET = "";
    const guard = guardFetcher();
    const result = await appThirdPartyLogin(
      env,
      appRequest(ROUTE),
      {platform: "qq", openid: "x", accessToken: "tok"},
      guard.fetcher,
    );
    expect(result).toBe("QQ 校验失败");
    expect(guard.called()).toBe(false);
  });

  it("只缺 QQ_APP_SECRET 也拒绝（两个键都必须在位）", async () => {
    env.QQ_APP_SECRET = "";
    const guard = guardFetcher();
    const result = await appThirdPartyLogin(
      env,
      appRequest(ROUTE),
      {platform: "qq", openid: "x", accessToken: "tok"},
      guard.fetcher,
    );
    expect(result).toBe("QQ 校验失败");
    expect(guard.called()).toBe(false);
  });

  it("真实模式：同 openid 重复登录复用同一凭证", async () => {
    const fetcher = qqMockFetcher("OPENID_REAL", TEST_APP_ID, "昵称", "https://a/1.jpg");
    const body = {platform: "qq", openid: "whatever", accessToken: "tok"};
    const first = await appThirdPartyLogin(env, appRequest(ROUTE), body, fetcher) as Record<string, unknown>;
    const second = await appThirdPartyLogin(env, appRequest(ROUTE), body, fetcher) as Record<string, unknown>;
    expect(second.Token).toBe(first.Token);
  });
});
