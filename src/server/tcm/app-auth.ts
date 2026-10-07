// App 端登录与令牌刷新（工单 12，spec `.scratch/tcm-import/spec.md` §6.1）。
//
// 适配决策（用户拍板：复用现有鉴权，不移植 AccessKey/HMAC 体系）：
// - 口令校验复用 better-auth（账号可为邮箱或用户名，与后台登录同一规则）。
// - 登录成功签发**绑定该用户的 `mflc_` 登录凭证**（不是设备级 API Key）：
//   App 带该 Token 作为 Bearer，服务端走 `decideLoginCredentialApiRequest`
//   → 用户 → 角色 → 权限（`app:mobile:access`）——即「用户的 key」模型。
// - 同一账号重复登录**复用同一把** `app-login:<account>` 凭证，避免触顶
//   `MAX_LOGIN_CREDENTIALS_PER_USER`（否则第 6 次登录会失败）。
// - 防重放/会话沿用现状，零 schema 变更。
// - 失败响应沿用旧后端的「HTTP 200 + JSON 字符串」形状，App 端解析逻辑不变。
//
// 旧后端响应字段（LoginOutPut）名称保持不变；按拍板不再下发
// AccessKeyId/AccessKeySecret，Token 字段承载 `mflc_` 凭证。

import {createMicrofeedAuth} from "@/server/auth/better-auth";
import {
  createLoginCredential,
  listLoginCredentialsForUser,
  LoginCredentialLimitError,
  verifyLoginCredentialToken,
} from "@/server/auth/login-credentials";
import type {LoginCredentialRecord} from "@/shared/LoginCredential";
import {accountIsBlocked, isDeviceRevoked} from "@/server/rbac/resolve";

/** createMicrofeedAuth 的运行时环境形状（与 Worker Env 一致）。 */
type MicrofeedRuntimeEnv = Parameters<typeof createMicrofeedAuth>[0];

const APP_LOGIN_CREDENTIAL_PREFIX = "app-login:";

interface AuthUserRow {
  email: string;
  id: string;
  name: string;
  username: string | null;
}

function looksLikeEmail(account: string): boolean {
  return account.includes("@");
}

/** 账号（邮箱或用户名）→ auth_user 行。查不到返回 null。 */
async function findAuthUser(
  database: D1Database,
  account: string,
): Promise<AuthUserRow | null> {
  const column = looksLikeEmail(account) ? "email" : "username";
  const row = await database.prepare(
    `SELECT id, email, name, username FROM "auth_user" WHERE ${column} = ? LIMIT 1`,
  ).bind(account.toLowerCase()).first<AuthUserRow>();
  return row ?? null;
}

/** 用户 id → auth_user 行（`replaceToken` 用）。查不到返回 null。 */
async function findAuthUserById(
  database: D1Database,
  id: string,
): Promise<AuthUserRow | null> {
  const row = await database.prepare(
    'SELECT id, email, name, username FROM "auth_user" WHERE id = ? LIMIT 1',
  ).bind(id).first<AuthUserRow>();
  return row ?? null;
}

/** App 登录凭证的稳定名（≤80，`normalizeLoginCredentialName` 上限）。 */
function appLoginCredentialName(user: AuthUserRow): string {
  return `${APP_LOGIN_CREDENTIAL_PREFIX}${user.username ?? user.email}`.slice(0, 80);
}

/**
 * 复用该账号尚未撤销的 App 登录凭证；没有则签发一把。
 * 触顶（该用户已有 5 把未撤销凭证）时返回 null，由调用方给出可读文案。
 */
async function ensureAppLoginCredential(
  database: D1Database,
  user: AuthUserRow,
): Promise<LoginCredentialRecord | null> {
  const name = appLoginCredentialName(user);
  const existing = (await listLoginCredentialsForUser(database, user.id))
    .find((record) => !record.revoked && record.name === name);
  if (existing) return existing;
  try {
    return await createLoginCredential(database, {userId: user.id, name});
  } catch (error) {
    if (error instanceof LoginCredentialLimitError) return null;
    throw error;
  }
}

/** 登录成功/失败共用的旧后端形状（缺省字段与 LoginOutPut 对齐）。 */
function loginPayload(
  token: string,
  account: string,
  user: AuthUserRow | null,
): Record<string, unknown> {
  return {
    Token: token,
    Account: account,
    Name: user?.name ?? "",
    Img: "",
    UserName: user?.username ?? account,
    DefaultModule: null,
    ModuleList: null,
  };
}

/** 在请求体里按大小写不敏感的方式取字符串字段。 */
function pickString(input: unknown, key: string): string {
  if (!input || typeof input !== "object") return "";
  const lower = key.toLowerCase();
  for (const [name, value] of Object.entries(input)) {
    if (name.toLowerCase() === lower && typeof value === "string") return value;
  }
  return "";
}

/**
 * 登录：校验账号口令，通过后签发/复用绑定该用户的 `mflc_` 登录凭证。
 * 返回值直接作为响应体（对象 = 成功；字符串 = 旧后端风格的失败文案）。
 */
export async function appLogin(
  runtimeEnv: MicrofeedRuntimeEnv,
  request: Request,
  input: unknown,
): Promise<unknown> {
  const database = runtimeEnv.FEED_DB;
  // 字段名大小写不敏感：Android Gson 发 `userName` / `passWord`（注意 `passWord`
  // 的大写 W，与 `Password`/`password` 都不同），后台/旧后端可能发 `UserName`/`Password`。
  const account = pickString(input, "username").trim();
  const password = pickString(input, "password");
  if (!account || !password) {
    return "请检查账号密码";
  }

  const user = await findAuthUser(database, account);
  if (!user) {
    // 不区分「账号不存在」与「口令错误」，避免账号枚举。
    return "登录失败,请检查账号密码";
  }

  const auth = createMicrofeedAuth(runtimeEnv as never, request);
  try {
    await auth.api.signInEmail({
      body: {email: user.email, password},
    });
  } catch {
    return "登录失败,请检查账号密码";
  }

  const credential = await ensureAppLoginCredential(database, user);
  if (!credential) {
    return "登录凭证数已达上限，请在后台清理后重试";
  }
  return loginPayload(credential.secret, account, user);
}

/**
 * 刷新令牌：校验 Bearer 的 `mflc_` 凭证后保形返回同一把 Token。
 * 凭证无过期语义，无需轮换——端点只为 App 的刷新调用保持可用。
 */
export async function appReplaceToken(
  database: D1Database,
  request: Request,
): Promise<unknown> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    return "请先登录";
  }
  const token = match[1] ?? "";
  const verified = await verifyLoginCredentialToken(database, token);
  if (!verified) {
    return "凭证无效或已过期";
  }
  // ADR-0011 D3：刷新令牌必须复用封禁/吊销检查（与 credential-bearer.ts:94/112
  // 一致）。内容端点虽已拦截封禁/吊销，但 replaceToken 此前是匿名直达的预认证通道，
  // 会让吊销设备续发新 Token 继续读。命中返回错误字符串（App 端按 data 类型判定失败，
  // 信封恒为 200，与 login 同形）。
  if (await accountIsBlocked(database, verified.userId)) {
    return "账号已被封禁";
  }
  if (await isDeviceRevoked(database, verified.userId, request)) {
    return "设备已被吊销";
  }
  const user = await findAuthUserById(database, verified.userId);
  const account = user?.username ?? user?.email ?? "";
  return loginPayload(token, account, user);
}
