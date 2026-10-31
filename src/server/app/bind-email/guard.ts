/**
 * 补充邮箱的「登录态 + 再认证 + 每账号配额」守卫（ADR-0015 D21 / §9.2 / F24 / F29）。
 *
 * ## 为什么绑邮箱要再认证
 *
 * `mflc_` 令牌是长期凭证。如果绑邮箱只校验"你带着令牌"，那么令牌一旦泄露，
 * 攻击者就能「绑自己的邮箱 → 走忘记密码 → 设新口令」，把**会话级**访问升级为
 * **账号所有权**（F29）。再认证要求攻击者额外提供只有本人才有的东西：
 * - QQ 账号：腾讯 accessToken（拿不到就验不出 openid）；
 * - 口令账号：当前口令。
 *
 * ## 为什么配额按账号算
 *
 * `rateLimitSend` 的计数键是 `(email, purpose)`，而绑定场景里 email 是**目标邮箱**
 * ——换个目标就是一份新配额，等于没有上限（F24）。这里用 `ext_auth_throttle`
 * 的 `bind-email-day:<userId>` 做 24 小时窗口，10 次/账号/日。
 */
import {verifyPassword} from "better-auth/crypto";

import {jsonResponse, readStringField} from "@/server/http";
import {appEnvelope} from "@/server/tcm/envelope";
import {providedLoginCredentialBearer} from "@/server/auth/credential-login";
import {verifyLoginCredentialToken} from "@/server/auth/login-credentials";
import {isDevMockEnabled, verifyQqToken} from "@/server/tcm/app-third-party";

/** 每账号每日绑定发码上限。 */
export const BIND_DAILY_LIMIT = 10;
const BIND_WINDOW_SECONDS = 24 * 60 * 60;

export interface AppUser {
  userId: string;
}

/**
 * 解析 `Authorization: Bearer mflc_…` 得到当前用户。
 * 失败返回 `Response`（调用方直接 `return`），成功返回 `{userId}`。
 */
export async function requireAppUser(
  database: D1Database,
  request: Request,
): Promise<AppUser | Response> {
  const token = providedLoginCredentialBearer(request);
  if (!token) {
    return jsonResponse(appEnvelope("请先登录"));
  }
  const verified = await verifyLoginCredentialToken(database, token);
  if (!verified || verified.banned) {
    return jsonResponse(appEnvelope("请先登录"));
  }
  return {userId: verified.userId};
}

export function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

/**
 * 再认证：证明"操作者是账号本人"，而不是"某个持有令牌的人"。
 *
 * **两条并列通道，任一通过即放行**（ADR-0014 D10 / I17）：
 *
 * - 口令：请求带 `password`，且该用户 `auth_account(providerId='credential')` 行比对通过；
 * - QQ：请求带 `openid` + `accessToken`，向腾讯校验后要求 openid 映射回**当前** userId。
 *
 * 为什么不是「有 QQ 绑定就只走 QQ」的 if/else：真实邮箱账号绑定 QQ 之后会同时具备
 * 两者，独占分支会把它从口令通道踢出去，而 Android **不持久化** QQ accessToken
 * （只在 QQ 登录那一刻存在）→ 该账号的「补充/更换邮箱」再认证等于关闭。
 * 口令与 accessToken 都是「只有本人有的东西」，并列不降低安全性。
 *
 * dev-mock（`QQ_OAUTH_DEV_MOCK=1` 且 host 在本机/局域网）跳过腾讯调用，但仍要求
 * openid 映射回当前 userId——旁路只省网络，不省归属校验。
 */
export async function verifyReauth(
  runtimeEnv: Env,
  request: Request,
  userId: string,
  body: unknown,
): Promise<Response | null> {
  const database = runtimeEnv.FEED_DB;
  const reject = (): Response =>
    jsonResponse(appEnvelope("身份验证失败，请重新登录后再试"));

  // 通道 1：口令。先试口令再试 QQ —— 顺序本身是需求，见函数文档（D10 / I17）。
  const password = readStringField(body, "password");
  if (password) {
    const credential = await database
      .prepare(
        "SELECT password FROM auth_account WHERE userId = ? AND providerId = 'credential' LIMIT 1",
      )
      .bind(userId)
      .first<{password: string | null}>();
    if (credential?.password
        && await verifyPassword({hash: credential.password, password})) {
      return null;
    }
  }

  // 通道 2：QQ。
  const qqBinding = await database
    .prepare(
      "SELECT user_id FROM ext_user_oauth WHERE provider = 'qq' AND user_id = ? LIMIT 1",
    )
    .bind(userId)
    .first<{user_id: string}>();
  if (!qqBinding) return reject();

  const openid = readStringField(body, "openid").trim();
  const accessToken = readStringField(body, "accessToken");
  if (!openid || !accessToken) return reject();

  let trustedOpenid = openid;
  if (!isDevMockEnabled(runtimeEnv, request)) {
    const verified = await verifyQqToken(
      accessToken,
      runtimeEnv.QQ_APP_ID ?? "",
    );
    if (verified.error) return reject();
    trustedOpenid = verified.result!.openid;
  }

  const owner = await database
    .prepare(
      "SELECT user_id FROM ext_user_oauth WHERE provider = 'qq' AND openid = ? LIMIT 1",
    )
    .bind(trustedOpenid)
    .first<{user_id: string}>();
  if (!owner || owner.user_id !== userId) return reject();
  return null;
}

/**
 * 每账号每日配额（`ext_auth_throttle`，键 `bind-email-day:<userId>`）。
 *
 * 与 `rateLimitSend` 的 IP 窗口同一张表、同一套 UPSERT 写法；区别只是窗口
 * 86400s、键里带 userId 而不是 email。返回 false 表示已用尽。
 */
export async function consumeBindQuota(
  database: D1Database,
  userId: string,
): Promise<boolean> {
  const key = `bind-email-day:${userId}`;
  const now = Math.floor(Date.now() / 1000);
  const row = await database
    .prepare("SELECT attempts, window_start FROM ext_auth_throttle WHERE key = ?")
    .bind(key)
    .first<{attempts: number; window_start: number}>();

  if (!row || now - row.window_start >= BIND_WINDOW_SECONDS) {
    await database
      .prepare(
        "INSERT INTO ext_auth_throttle (key, attempts, window_start) VALUES (?, 1, ?) " +
          "ON CONFLICT(key) DO UPDATE SET attempts = 1, window_start = excluded.window_start",
      )
      .bind(key, now)
      .run();
    return true;
  }
  if (row.attempts >= BIND_DAILY_LIMIT) return false;
  await database
    .prepare("UPDATE ext_auth_throttle SET attempts = attempts + 1 WHERE key = ?")
    .bind(key)
    .run();
  return true;
}
