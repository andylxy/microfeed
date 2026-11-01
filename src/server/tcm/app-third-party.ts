// App 第三方登录（ADR-0013，见 AndroidProject-old 仓 docs/adr/0013-qq-third-party-login.md；
// 本期仅 QQ）。
//
// 安全模型：
// - 客户端只报 openid / accessToken，后端必须向腾讯校验，绝不信任客户端自报 openid。
// - 校验通过才 upsert auth_user + ext_user_oauth，复用账号登录的登录凭证签发
//   （ensureAppLoginCredential → mflc_ 凭证），返回与账号登录同款的 LoginOutPut 形状。
// - 并发首登同 openid：INSERT OR IGNORE + 回查，避免 UNIQUE 冲突 → 未捕获 500。
// - 验证码闸门不套第三方登录（第三方无 verificationCode 输入）。
//
// 「模拟先行」：没有真实 QQ 密钥时用 QQ_OAUTH_DEV_MOCK 跳过腾讯校验、信任客户端
// openid 做本地联调。该旁路由 {@link isDevMockEnabled} 按请求 host 判定，只在本机 /
// 局域网地址生效——即使线上把该变量置成 "1"，生产域名也命不中白名单，旁路开不出来。
// 业务闸（loginEnabled / qqEnabled / 密钥存在）在任何模式下都参与，不被旁路跳过。

import {cache} from "cloudflare:workers";

import {authUserInsertSql} from "@/server/auth/account-insert";
import {createMicrofeedAuth} from "@/server/auth/better-auth";
import {
  ensureAppLoginCredential,
  type AuthUserRow,
} from "@/server/auth/login-credentials";
import {PLACEHOLDER_EMAIL_DOMAIN} from "@/shared/AdminCredentials";
import FeedDb from "@/server/feed/FeedDb";
import {readStringField} from "@/server/http";
import {accountIsBlocked} from "@/server/rbac/resolve";
import {enforceLoginMethodsGates, readLoginMethodsConfigCached} from "@/server/app/login/config";

/** createMicrofeedAuth 的运行时环境形状（与 Worker Env 一致）。 */
type MicrofeedRuntimeEnv = Parameters<typeof createMicrofeedAuth>[0];

interface QqVerifyResult {
  clientId: string;
  openid: string;
}

/**
 * 校验失败一律回同一句对外文案（ADR §3 失败表只列「QQ 校验失败」一条），
 * 具体原因只写服务端日志：既保持客户端文案稳定，也不把内部细节透给外部。
 */
function verificationFailed(reason: string): {error: string} {
  console.warn(`[thirdPartyLogin] QQ 校验失败：${reason}`);
  return {error: "QQ 校验失败"};
}

/**
 * 向腾讯校验 accessToken，取回权威 openid 与 client_id。
 * fetcher 可注入（单测 mock）；默认走全局 fetch。
 */
export async function verifyQqToken(
  accessToken: string,
  allowedAppIds: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<{error?: string; result?: QqVerifyResult}> {
  // QQ_APP_ID 现为逗号分隔的「允许清单」（release/debug/preview 各一个 AppID）。
  // 腾讯 oauth2.0/me 回的 client_id 命中清单任一即视为本应用颁发的 token（防重放别家 token）。
  const allowed = (allowedAppIds ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0) return verificationFailed("QQ_APP_ID 未配置");

  const url = `https://graph.qq.com/oauth2.0/me?access_token=${encodeURIComponent(accessToken)}&fmt=json`;
  let resp: Response;
  try {
    resp = await fetcher(url);
  } catch (error) {
    return verificationFailed(`请求 oauth2.0/me 抛错：${String(error)}`);
  }
  if (!resp.ok) return verificationFailed(`oauth2.0/me 返回 HTTP ${resp.status}`);

  const text = await resp.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Tencent 默认用 callback(...) 包裹；fmt=json 时应已是纯 JSON，这里兜底剥壳。
    const match = text.match(/callback\(\s*(\{[\s\S]*\})\s*\)\s*;?\s*$/u);
    if (!match) return verificationFailed("响应既非 JSON 也无 callback 包裹");
    try {
      json = JSON.parse(match[1]!) as Record<string, unknown>;
    } catch {
      return verificationFailed("callback 包裹体无法解析");
    }
  }

  // Tencent 错误形态：{ error: <非零>, error_description } 或 { ret: <非零>, msg }。
  if (typeof json.error === "number" && json.error !== 0) {
    return verificationFailed(`腾讯返回 error=${json.error}`);
  }
  if (typeof json.ret === "number" && json.ret !== 0) {
    return verificationFailed(`腾讯返回 ret=${json.ret}`);
  }

  const openid = typeof json.openid === "string" ? json.openid : "";
  const clientId = typeof json.client_id === "string" ? json.client_id : "";
  if (!openid || !clientId) return verificationFailed("响应缺 openid 或 client_id");
  // client_id 必须命中本应用的 QQ_APP_ID 允许清单，证明 token 是发给本应用某变体的（防重放别家 token）。
  if (!allowed.includes(clientId)) {
    return verificationFailed(`client_id 不在允许清单：${clientId}`);
  }

  return {result: {clientId, openid}};
}

/** 拉取 QQ 昵称/头像（best-effort：失败只降级为空串，不阻断登录）。 */
async function fetchQqUserInfo(
  accessToken: string,
  openid: string,
  appId: string,
  fetcher: typeof fetch = fetch,
): Promise<{avatar: string; nickname: string}> {
  // ADR-0013 §5.2 D：get_user_info 必须带 &format=json，腾讯才返回规范的 JSON 形态
  // （否则默认 callback(...) 包裹，resp.json() 可能抛错、昵称/头像静默丢）。
  const url = `https://graph.qq.com/user/get_user_info?access_token=${encodeURIComponent(accessToken)}` +
    `&oauth_consumer_key=${encodeURIComponent(appId)}&openid=${encodeURIComponent(openid)}` +
    `&format=json`;
  try {
    const resp = await fetcher(url);
    if (!resp.ok) {
      console.warn(`[thirdPartyLogin] get_user_info 返回 HTTP ${resp.status}，昵称/头像降级为空`);
      return {avatar: "", nickname: ""};
    }
    const json = (await resp.json()) as Record<string, unknown>;
    if (typeof json.ret === "number" && json.ret !== 0) {
      console.warn(`[thirdPartyLogin] get_user_info 返回 ret=${json.ret}，昵称/头像降级为空`);
      return {avatar: "", nickname: ""};
    }
    const avatar = typeof json.figureurl_qq_2 === "string" ? json.figureurl_qq_2
      : typeof json.figureurl_qq_1 === "string" ? json.figureurl_qq_1
      : typeof json.figureurl === "string" ? json.figureurl : "";
    const nickname = typeof json.nickname === "string" ? json.nickname : "";
    return {avatar, nickname};
  } catch (error) {
    console.warn(`[thirdPartyLogin] get_user_info 抛错：${String(error)}，昵称/头像降级为空`);
    return {avatar: "", nickname: ""};
  }
}

/** 按 openid 查已绑定的 user_id（ext_user_oauth 主键 provider+openid）。 */
async function findUserIdByOpenid(database: D1Database, openid: string): Promise<string | null> {
  const row = await database.prepare(
    "SELECT user_id FROM ext_user_oauth WHERE provider = 'qq' AND openid = ? LIMIT 1",
  ).bind(openid).first<{user_id: string}>();
  return row?.user_id ?? null;
}

/** 绑定 (qq, openid) → auth_user；主键冲突忽略（并发首登 / 重复登录都安全）。 */
async function bindOpenid(database: D1Database, openid: string, userId: string): Promise<void> {
  await database.prepare(
    "INSERT OR IGNORE INTO ext_user_oauth (provider, openid, user_id, created_at_ms) VALUES ('qq', ?, ?, ?)",
  ).bind(openid, userId, Date.now()).run();
}

/**
 * 幂等建号：INSERT OR IGNORE，冲突（并发首登 / 同一 openid 换个大小写）时按
 * email 或 username 回查取回已有 id，避免 UNIQUE 冲突。成功后绑定 ext_user_oauth
 * （主键冲突忽略）。两条唯一键都查不到时抛错——绝不把 openid 绑到没插进去的 id。
 */
async function createQqUser(
  database: D1Database,
  openid: string,
  nickname: string,
  avatar: string,
): Promise<string> {
  // 占位域统一为单一占位域（ADR-0014 rev.9 / I7）：QQ 建号与用户名建号的合成
  // 地址都收敛到这一个域，判定只写一处（PLACEHOLDER_EMAIL_DOMAIN），不再分域。
  const email = `qq_${openid}@${PLACEHOLDER_EMAIL_DOMAIN}`;
  const username = `qq_${openid.toLowerCase()}`;
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  const insert = await database.prepare(
    // `signup_source` 显式写 'qq'（ADR-0014 D8 / I9）。必须显式写，不能靠迁移回填：
    // 回填按 email 后缀推导，而用户一旦补了邮箱（bindEmailCommit）后缀就没了，
    // 那时已无法证明这个账号当初是 QQ 建号（§6.2 回填时间窗）。
    authUserInsertSql({
      orIgnore: true,
      signupSource: "qq",
      withImage: true,
      withUsername: true,
    }),
  ).bind(
    id,
    nickname || `qq_${openid}`,
    email,
    avatar || null,
    now,
    now,
    username,
    nickname || null,
  ).run();

  if ((insert.meta?.changes ?? 0) === 0) {
    // `INSERT OR IGNORE` 吞掉的是**任意**唯一约束冲突，不止 email：
    // email 保留原始大小写、username 走 toLowerCase()，两者不是一对一，同一 openid
    // 换头大小写时会出现「email 不冲突、username 冲突」→ 整行被忽略。所以回查必须
    // 同时按 username 兜一层，否则会走到下面把 openid 绑到一个从未插入成功的 id 上
    // （幽灵绑定：该 openid 之后每次登录都「登录失败」，且不自愈）。
    //
    // 代价：email / username 各有一条 UNIQUE 索引，SQLite 的 OR 优化会把两个索引的
    // 结果并起来，各至多 1 行；即使退化也只在 auth_user 上走一遍，可接受。
    const existing = await database.prepare(
      'SELECT id, email, username FROM "auth_user" WHERE email = ? OR username = ? LIMIT 1',
    ).bind(email, username).first<{id: string; email: string; username: string | null}>();
    if (!existing) {
      // 两条唯一键都查不到 → INSERT 被别的原因忽略（不是并发、也不是重名）。
      // 这里必须失败退出：继续 bindOpenid 会写出一条指向不存在用户的绑定。
      throw new Error(
        `QQ 建号失败：INSERT OR IGNORE 未写入且按 email/username 均查不到 (openid=${openid})`,
      );
    }
    // username 是全局命名空间，真人账号可能恰好占用 `qq_<openid>` 这个名字。命中的行
    // 必须是同一 openid 派生出来的账号，否则会把这张 QQ 的登录态签到别人账上。
    // 按小写比较，覆盖「同一 openid 换头大小写」这种情况。
    // email 与 username **都要**对得上（ADR-0015 F28 L2）。
    // 只比 email 时，占位地址一旦被抢占（别人把 `qq_<victim>@users.microfeed.local` 绑到自己
    // 名下），受害者首登就会命中这一行、判等通过，随后 `bindOpenid` 把受害者
    // openid 绑到抢占者的 userId——顶号。合法行的 username 必定是
    // `qq_<openid 小写>`（上面生成规则），对不上就说明这行不是本 openid 的。
    // 此时宁可让本次登录失败并告警，也绝不把 openid 绑给别人的账号。
    if (existing.email.toLowerCase() !== email.toLowerCase() ||
        (existing.username ?? "").toLowerCase() !== username.toLowerCase()) {
      throw new Error(
        `QQ 建号失败：占位标识被非本 openid 的行占用 (existing=${existing.email}/${existing.username})`,
      );
    }
    await refreshProfile(database, existing.id, nickname, avatar);
    await bindOpenid(database, openid, existing.id);
    return existing.id;
  }

  await bindOpenid(database, openid, id);
  return id;
}

/**
 * 空壳账号判定（ADR-0014 D4 / I4）：QQ 首登自动建号产生的占位邮箱
 * `qq_<openid>@users.microfeed.local`（域已统一，ADR-0014 rev.9）。
 *
 * 注意它与 `isPlaceholderEmail` 的区别：后者只认「域」，凡
 * `@users.microfeed.local`（含后台用户名建号 `xiaoyang@users.microfeed.local`）都算；
 * 而这里靠 `qq_` 前缀把「QQ 自动建出的空壳」从「后台建号」里分出来——
 * 只有空壳才允许被 QQ 侧资料覆盖（后台建号是受控账号，资料归自己）。
 */
function isQqShellEmail(email: string | null): boolean {
  const value = (email ?? "").trim().toLowerCase();
  return value.startsWith("qq_") && value.endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`);
}

/** 取 auth_user 行（用于签发凭证与组包）。 */
async function findAuthUserById(database: D1Database, id: string): Promise<AuthUserRow | null> {
  // `email_usable` 同 `findAuthUser`：读生成列，不在 TS 侧重算（I10 双源同步）。
  return database.prepare(
    'SELECT id, email, name, username, image, email_usable FROM "auth_user" ' +
      "WHERE id = ? LIMIT 1",
  ).bind(id).first<AuthUserRow>();
}

/** best-effort 刷新昵称/头像（再登不丢更新）。空值不覆盖既有值，但 updatedAt 每次都写。 */
async function refreshProfile(
  database: D1Database,
  id: string,
  nickname: string,
  avatar: string,
): Promise<void> {
  if (!nickname && !avatar) return;
  await database.prepare(
    'UPDATE "auth_user" SET name = COALESCE(NULLIF(?, ""), name), ' +
      'image = COALESCE(NULLIF(?, ""), image), updatedAt = ? WHERE id = ?',
  ).bind(nickname, avatar, new Date().toISOString(), id).run();
}

/** 第三方登录专用响应（不复用 loginPayload：它固定写入 `Img=""`、`UserName=username??account`）。 */
function thirdPartyLoginPayload(
  token: string,
  account: string,
  user: AuthUserRow,
  nickname: string,
  avatar: string,
): Record<string, unknown> {
  return {
    Token: token,
    Account: account,
    Email: user.email ?? "",
    Name: nickname || user.name || account,
    Img: avatar || "",
    UserName: nickname || user.name || account,
    // 与 `loginPayload` 同义同口径（ADR-0014 D9）：QQ 建号的占位邮箱恒为 0，
    // 补过邮箱之后变成 1。`signup_source` 按下发范围决议**不下发**。
    EmailUsable: user.email_usable ?? null,
    DefaultModule: null,
    ModuleList: null,
  };
}

/** dev-mock 允许的主机名：本机回环的常见写法。 */
const DEV_MOCK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

/** RFC1918 私有网段与回环 IPv4（局域网联调，例如 Android 模拟器打 192.168.x.x）。 */
function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return false;
    const value = Number(part);
    if (value > 255) return false;
    octets.push(value);
  }
  const a = octets[0]!;
  const b = octets[1]!;
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * 「模拟先行」旁路的判定：必须同时满足
 *   1. `QQ_OAUTH_DEV_MOCK === "1"`（本地 `.dev.vars` 显式打开）；
 *   2. 请求 host 是本机 / 局域网地址。
 * 第 2 条是关键——生产域名命中不了白名单，所以**即使线上把该变量误置成 "1"**，
 * 旁路也开不出来。这样旁路的安全性不再依赖「线上别去设它」这种人工约定。
 */
export function isDevMockEnabled(runtimeEnv: MicrofeedRuntimeEnv, request: Request): boolean {
  if (runtimeEnv.QQ_OAUTH_DEV_MOCK !== "1") return false;
  const hostname = new URL(request.url).hostname;
  return DEV_MOCK_HOSTNAMES.has(hostname) || isPrivateIpv4(hostname);
}

/**
 * 第三方登录：校验身份 → 解析/创建用户 → 签发登录凭证。
 * 返回值直接作为响应体（对象 = 成功；字符串 = 旧后端风格的失败文案）。
 */
export async function appThirdPartyLogin(
  runtimeEnv: MicrofeedRuntimeEnv,
  request: Request,
  input: unknown,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const database = runtimeEnv.FEED_DB;
  const isDevMock = isDevMockEnabled(runtimeEnv, request);

  // 后台「登录管理」开关（总闸 + QQ 方式闸）。旁路只跳过腾讯校验，业务闸门一律参与。
  const loginMethods = await readLoginMethodsConfigCached(
    new FeedDb(runtimeEnv, request, cache),
  );
  // 方式闸用 qqEnabled（QQ 登录这条路径）。两端共用 enforceLoginMethodsGates。
  const gate = enforceLoginMethodsGates(loginMethods, loginMethods.qqEnabled);
  if (gate) return gate;
  // 密钥缺失 fail-closed：绝不带空密钥去调腾讯（ADR-0013 §5.2 C.3）。
  // dev-mock 同样要求密钥位非空——本地 `.dev.vars` 放占位值即可，线上缺密钥一律拒绝。
  if (!runtimeEnv.QQ_APP_ID || !runtimeEnv.QQ_APP_SECRET) return "QQ 校验失败";

  const platform = readStringField(input, "platform").trim();
  if (!platform) return "参数缺失，请重试";
  if (platform !== "qq") return "暂不支持";

  const openid = readStringField(input, "openid").trim();
  const accessToken = readStringField(input, "accessToken");
  if (!openid || !accessToken) return "参数缺失，请重试";

  let trustedOpenid = openid;
  let nickname = "";
  let avatar = "";

  if (isDevMock) {
    // 本地模拟：信任客户端 openid，昵称用占位（真实昵称需腾讯 get_user_info，dev-mock 跳过）。
    nickname = `QQ_${openid.slice(0, 8)}`;
  } else {
    const v = await verifyQqToken(accessToken, runtimeEnv.QQ_APP_ID, fetcher);
    if (v.error) return v.error;
    trustedOpenid = v.result!.openid;

    const info = await fetchQqUserInfo(accessToken, trustedOpenid, v.result!.clientId, fetcher);
    nickname = info.nickname;
    avatar = info.avatar;
  }

  // 解析或创建用户（ext_user_oauth 关联）。
  let userId = await findUserIdByOpenid(database, trustedOpenid);
  if (!userId) {
    userId = await createQqUser(database, trustedOpenid, nickname, avatar);
  }

  const user = await findAuthUserById(database, userId);
  if (!user) return "登录失败，请稍后重试";

  if (await accountIsBlocked(database, userId)) return "登录失败，请稍后重试";

  // D4 / I4：只有**空壳账号**才用 QQ 昵称/头像刷新资料（best-effort）。
  // 绑定到真实账号之后，openid 指向的是用户自己的账号，这里再刷就会把用户自己改过的
  // 名字和头像覆盖掉 —— 而 `auth_user` 没有历史值备份，改不回去，且每次登录都会再改一次。
  // 组包用的是腾讯刚返回的值，所以刷新与否不影响本次响应体。
  if ((nickname || avatar) && isQqShellEmail(user.email)) {
    await refreshProfile(database, userId, nickname, avatar);
  }

  const credential = await ensureAppLoginCredential(database, user);
  if (!credential) return "登录凭证数已达上限，请在后台清理后重试";

  const account = `qq_${trustedOpenid}`;
  const finalNickname = nickname || user.name || account;
  const finalAvatar = avatar || user.image || "";
  return thirdPartyLoginPayload(credential.secret, account, user, finalNickname, finalAvatar);
}
