// App 账号绑定：把 QQ 身份（auth_account 的 providerId='qq' 绑定行，ADR-0055）
// 与既有账号关联 / 解关联。
//
// 方案见 AndroidProject-old 仓 docs/adr/0014-qq-account-binding-and-phone.md（rev.6）。
// 与 `bindEmailSend/Commit`（补邮箱）是同一个「已登录态 + 端点自鉴权」家族：
// 中间件把这批路由当匿名放行（见 `access.ts` 的匿名登记表），鉴权由这里自己做。
//
// 三条硬约束（对应 ADR 的 I2 / I14 / I15 / I16）：
//   I2  —— 先给目标账号签好凭证，再改绑；改绑 UPDATE 必须带旧 user_id 且 changes===1。
//          反序会让「改绑成功但返回失败」，用户重试时被判「已绑其他账号」而永久卡死。
//   I14 —— 解绑不得让账号失去最后一条登录通路：解绑前必须有口令行。
//   I15 —— `bindAccount` 校验目标账号口令，必须登记限流（见 auth-endpoint-throttle.ts）。
//   I16 —— 验密用的 `signInEmail` 返回值必须丢弃：它是 App 端点，把目标账号的后台
//          会话 cookie 写进响应等于把别人的后台登录态发给客户端。

import {cache} from "cloudflare:workers";

import {createMicrofeedAuth} from "@/server/auth/better-auth";
import {
  ensureAppLoginCredential,
  type AuthUserRow,
} from "@/server/auth/login-credentials";
import FeedDb from "@/server/feed/FeedDb";
import {jsonResponse, readStringField} from "@/server/http";
import {accountIsBlocked} from "@/server/rbac/resolve";
import {
  enforceLoginMethodsGates,
  readLoginMethodsConfigCached,
} from "@/server/app/login/config";
import {loginPayload} from "@/server/tcm/app-auth";
import {appEnvelope} from "@/server/tcm/envelope";
import {isResponse, requireAppUser} from "@/server/app/bind-email/guard";

type MicrofeedRuntimeEnv = Parameters<typeof createMicrofeedAuth>[0];

/** 失败文案（§4.3 全表）。「目标不存在 / 无口令 / 封禁 / 验密失败」四者合并成一句，避免账号枚举。 */
const CREDENTIALS_REJECTED = "账号或密码错误";

/** 目标账号行（组包需要 email / username / email_usable）。 */
interface TargetRow extends AuthUserRow {
  email_usable?: number | null;
}

/**
 * 按邮箱定位目标账号。
 *
 * 先走 `email = ?`（大小写敏感的 UNIQUE 索引，命中绝大多数行），未命中再走
 * `lower(email) = ?`。第二条不能省：`auth_user.email` 的唯一索引**大小写敏感**
 * （实测 `email = 'qq_3974…b9d@users.microfeed.local'` 命中 0 行、
 * `lower(email) = …` 命中 1 行），而 QQ 建号的占位邮箱保留 openid 的原始大写
 * （`qq_<OPENID>@users.microfeed.local`，域已统一 rev.9）。
 * 兜底条件的索引见迁移 `0158_schema_auth_user_email_lower.sql`。
 */
async function findTargetByEmail(
  database: D1Database,
  email: string,
): Promise<TargetRow | null> {
  const normalized = email.trim().toLowerCase();
  const columns =
    'SELECT id, email, name, username, image, email_usable FROM "auth_user" ';
  const exact = await database.prepare(`${columns}WHERE email = ? LIMIT 1`)
    .bind(normalized).first<TargetRow>();
  if (exact) return exact;
  return database.prepare(`${columns}WHERE lower(email) = ? LIMIT 1`)
    .bind(normalized).first<TargetRow>();
}

/**
 * 把 `auth_account.createdAt` 换算成毫秒时间戳（响应字段 `BoundAtMs` 保持
 * 与旧 `ext_user_oauth.created_at_ms` 一致的毫秒语义）。
 *
 * 该列存量有两种格式：应用写入的 ISO（`2024-01-01T…Z`）与迁移 0165 回填写入的
 * `CURRENT_TIMESTAMP`（`YYYY-MM-DD HH:MM:SS`，UTC、无时区标记）。SQLite 的
 * CURRENT_TIMESTAMP 是 UTC，无标记时补 `Z` 统一按 UTC 解析；解析失败回 0。
 */
function boundAtMs(createdAt: string): number {
  const normalized = createdAt.includes("T")
    ? createdAt
    : `${createdAt.replace(" ", "T")}Z`;
  const value = Date.parse(normalized);
  return Number.isNaN(value) ? 0 : value;
}

/**
 * 绑定状态查询（§4.0）。
 *
 * 不返回 openid（客户端用不到，且解绑也不需要它），也不返回 QQ 昵称——绑定后
 * `refreshProfile` 不再写目标账号（D4），`auth_user.name` 是目标账号自己的名字，
 * 当「QQ 昵称」展示就是第二个 A14 字段不同源。
 */
export async function appGetAccountBindings(
  runtimeEnv: MicrofeedRuntimeEnv,
  request: Request,
): Promise<unknown> {
  const database = runtimeEnv.FEED_DB;
  const user = await requireAppUser(database, request);
  if (isResponse(user)) return user;

  const bindings = await database.prepare(
    'SELECT "providerId" AS provider, "createdAt" FROM "auth_account" ' +
      'WHERE "providerId" = \'qq\' AND "userId" = ? ORDER BY "createdAt"',
  ).bind(user.userId).all<{createdAt: string; provider: string}>();

  // 解绑前置（I14）：有没有口令决定「解绑」按钮能不能点。
  const credential = await database.prepare(
    "SELECT 1 AS ok FROM auth_account WHERE userId = ? AND providerId = 'credential' LIMIT 1",
  ).bind(user.userId).first<{ok: number}>();

  const usable = await database.prepare(
    'SELECT email_usable FROM "auth_user" WHERE id = ? LIMIT 1',
  ).bind(user.userId).first<{email_usable: number | null}>();

  return {
    Bindings: (bindings.results ?? []).map((row) => ({
      BoundAtMs: boundAtMs(row.createdAt),
      Provider: row.provider,
    })),
    EmailUsable: usable?.email_usable ?? null,
    HasPassword: credential ? 1 : 0,
    QqBound: (bindings.results ?? []).some((row) => row.provider === "qq") ? 1 : 0,
  };
}

/**
 * 绑定：把当前 QQ 会话名下的全部 openid 重定向到目标账号（§4.1）。
 *
 * openid **只从库推导**，不接受客户端传值：`mflc_` 凭证不带 provider/openid 列，
 * 服务端无法验证客户端自报的 openid 归属（D2）。
 */
export async function appBindAccount(
  runtimeEnv: MicrofeedRuntimeEnv,
  request: Request,
  input: unknown,
): Promise<unknown> {
  const database = runtimeEnv.FEED_DB;

  const email = readStringField(input, "email").trim();
  const password = readStringField(input, "password");
  if (!email || !password) return "参数缺失，请重试";

  // 总闸 + QQ 方式闸：绑定是 QQ 登录链路的一部分，QQ 停用时也不该放行。
  const loginMethods = await readLoginMethodsConfigCached(
    new FeedDb(runtimeEnv as never, request, cache),
  );
  const gate = enforceLoginMethodsGates(loginMethods, loginMethods.qqEnabled);
  if (gate) return gate;

  const user = await requireAppUser(database, request);
  if (isResponse(user)) return user;

  // 当前会话名下的 openid（D3：全部重定向）。
  const owned = await database.prepare(
    'SELECT "accountId" AS openid FROM "auth_account" ' +
      'WHERE "providerId" = \'qq\' AND "userId" = ?',
  ).bind(user.userId).all<{openid: string}>();
  const openids = (owned.results ?? []).map((row) => row.openid);
  if (openids.length === 0) return "该账号未关联 QQ，请先用 QQ 登录";

  const target = await findTargetByEmail(database, email);
  // 目标不存在 / 无口令 / 封禁 / 验密失败，四者同文案（防枚举）。
  if (!target) return CREDENTIALS_REJECTED;
  if (target.id === user.userId) return "已是同一账号";

  const credential = await database.prepare(
    "SELECT 1 AS ok FROM auth_account WHERE userId = ? AND providerId = 'credential' LIMIT 1",
  ).bind(target.id).first<{ok: number}>();
  if (!credential) return CREDENTIALS_REJECTED;

  if (await accountIsBlocked(database, target.id)) return CREDENTIALS_REJECTED;

  // I16：照 `app-auth.ts` 的写法，await 之后丢弃返回值。透传会把目标账号的后台
  // 会话 cookie 写进这个 App 端点的响应。
  try {
    await createMicrofeedAuth(runtimeEnv as never, request).api.signInEmail({
      body: {email: target.email, password},
    });
  } catch {
    return CREDENTIALS_REJECTED;
  }

  // I2：先确保目标账号有可用凭证，再改绑。反序 = 改绑成功却返回失败。
  const issued = await ensureAppLoginCredential(database, target);
  if (!issued) return "登录凭证数已达上限，请在后台清理后重试";

  for (const openid of openids) {
    const moved = await database.prepare(
      'UPDATE "auth_account" SET "userId" = ? WHERE "providerId" = \'qq\' ' +
        'AND "accountId" = ? AND "userId" = ?',
    ).bind(target.id, openid, user.userId).run();
    if ((moved.meta?.changes ?? 0) !== 1) return "绑定失败，请重试";
  }

  // D7 / G3：空壳名下凭证全部吊销，**含本次请求用的那一把**。凭证名可能是
  // `app-login:<email>`（`appLoginCredentialName` 取 username ?? email），
  // 所以按 user_id 全吊销，不能只按 name 匹配一把。失败不回滚绑定：最坏情况是
  // 客户端拿旧令牌得到 401，重新 QQ 登录会落到目标账号（openid 已重定向）→ 可自愈。
  await database.prepare(
    "UPDATE ext_login_credentials SET revoked = 1 WHERE user_id = ?",
  ).bind(user.userId).run().catch(() => undefined);

  return loginPayload(issued.secret, target.username ?? target.email, target);
}

/**
 * 解绑（§4.2）：删除当前会话名下全部 `providerId='qq'` 的行。
 *
 * 不接受 openid 入参 —— 三个登录响应都不返回它，客户端拿不到（G1）。
 */
export async function appUnbindAccount(
  runtimeEnv: MicrofeedRuntimeEnv,
  request: Request,
  input: unknown,
): Promise<unknown> {
  const database = runtimeEnv.FEED_DB;

  const provider = readStringField(input, "provider").trim();
  if (provider !== "qq") return "参数缺失，请重试";

  const user = await requireAppUser(database, request);
  if (isResponse(user)) return user;

  // I14：App 只有「账号口令」与「QQ」两条登录通路，纯 QQ 账号解绑后永久锁死。
  const credential = await database.prepare(
    "SELECT 1 AS ok FROM auth_account WHERE userId = ? AND providerId = 'credential' LIMIT 1",
  ).bind(user.userId).first<{ok: number}>();
  if (!credential) return "请先补充邮箱并设置密码后再解绑";

  const deleted = await database.prepare(
    "DELETE FROM auth_account WHERE providerId = 'qq' AND userId = ?",
  ).bind(user.userId).run();
  if ((deleted.meta?.changes ?? 0) === 0) return "未找到该绑定";

  return {QqBound: 0};
}

/** 路由共用：对象/字符串包进信封，Response（未登录等）直接透传。 */
export function bindingEnvelope(result: unknown): Response {
  if (result instanceof Response) return result;
  if (typeof result === "string") return jsonResponse(appEnvelope(result));
  return jsonResponse(appEnvelope(result as Record<string, unknown>));
}
