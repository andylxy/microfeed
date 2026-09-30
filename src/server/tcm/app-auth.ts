// App 端登录与令牌刷新（工单 12，spec `.scratch/tcm-import/spec.md` §6.1）。
//
// 适配决策（用户拍板：复用现有鉴权，不移植 AccessKey/HMAC 体系）：
// - 口令校验复用 better-auth（账号可为邮箱或用户名，与后台登录同一规则）
// - 凭证签发现有 api_keys（Bearer，scope=content:read），App 带 Token 访问
// - 防重放/会话沿用现状（ext_replay_nonces 已在用），零 schema 变更
// - 失败响应沿用旧后端的「HTTP 200 + JSON 字符串」形状，App 端解析逻辑不变
//
// 旧后端响应字段（LoginOutPut）名称保持不变；按拍板不再下发
// AccessKeyId/AccessKeySecret，Token 字段承载 API Key。

import {createApiKey} from "@/server/api/api-keys";
import {createMicrofeedAuth} from "@/server/auth/better-auth";

/** createMicrofeedAuth 的运行时环境形状（与 Worker Env 一致）。 */
type MicrofeedRuntimeEnv = Parameters<typeof createMicrofeedAuth>[0];

const API_KEY_NAME_PREFIX = "app-login:";

export interface AppLoginInput {
  UserName: string;
  Password: string;
}

interface AuthUserRow {
  email: string;
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
    `SELECT email, name, username FROM "auth_user" WHERE ${column} = ? LIMIT 1`,
  ).bind(account.toLowerCase()).first<{email: string; name: string; username: string | null}>();
  return row ?? null;
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

/**
 * 登录：校验账号口令，通过后签发 content:read API Key。
 * 返回值直接作为响应体（对象 = 成功；字符串 = 旧后端风格的失败文案）。
 */
export async function appLogin(
  runtimeEnv: MicrofeedRuntimeEnv,
  request: Request,
  input: Partial<AppLoginInput> | null,
): Promise<unknown> {
  const database = runtimeEnv.FEED_DB;
  const account = String(input?.UserName ?? "").trim();
  const password = String(input?.Password ?? "");
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

  // 名称带时间后缀：同一账号重复登录各得一把钥匙，避免唯一名冲突。
  const keyName = `${API_KEY_NAME_PREFIX}${account}#${Date.now().toString(36)}`.slice(0, 80);
  const key = await createApiKey(database, {
    name: keyName,
    scopes: ["content:read"],
  });
  return loginPayload(key.apiKey, account, user);
}

/**
 * 刷新令牌：校验 Bearer 凭证后保形返回。
 * API Key 无过期语义，无需轮换——端点只为 App 的刷新调用保持可用。
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
  const row = await database.prepare(
    "SELECT name FROM api_keys WHERE api_key = ? LIMIT 1",
  ).bind(match[1] ?? "").first<{name: string}>();
  if (!row) {
    return "凭证无效或已过期";
  }
  const name = row.name;
  const account = name.startsWith(API_KEY_NAME_PREFIX)
    ? name.slice(API_KEY_NAME_PREFIX.length).split("#")[0] ?? ""
    : "";
  const user = account ? await findAuthUser(database, account) : null;
  return loginPayload(match[1] ?? "", account, user);
}
