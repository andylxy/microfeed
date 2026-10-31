/**
 * 忘记密码 / 补充邮箱共用的「账号识别」与「占位域判定」（ADR-0015 D3/D15/D17）。
 *
 * 两个流程都只认邮箱，且都要拒绝三类收不到信的合成地址。放在一处，避免两条
 * 链路各写一份 endsWith 白名单而漂移。
 */

import {PLACEHOLDER_EMAIL_DOMAIN} from "@/shared/AdminCredentials";

/** 忘记密码用的 OTP 用途。必须服务端硬编码，不接受客户端传入（D14）。 */
export const PWD_RESET_PURPOSE = "password_reset";
/** 补充邮箱用的 OTP 用途。 */
export const BIND_EMAIL_PURPOSE = "bind_email";

/**
 * 永远收不到信的合成域（D15）：`PLACEHOLDER_EMAIL_DOMAIN`（ADR-0014 rev.9 / I7，
 * `@/shared/AdminCredentials` 的唯一定义）。QQ 建号与用户名建号都收敛到这一个域，
 * `.local` 不参与全局 DNS 委派。
 *
 * 判定用「后缀 + 小写」，与 SQL 侧的 `lower(email) LIKE '%@xxx'` 同口径。
 */
export function isPlaceholderEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return normalized.endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`);
}

export interface EmailAccount {
  id: string;
  email: string;
}

/**
 * 按邮箱找账号（D17）：`lower(email) = ?`，与 `auth_user.email` 的 BINARY UNIQUE
 * 解耦——存量里若有大写地址，`= ?` 会静默查不到。
 *
 * 命中 0 行或 **多于 1 行**（大小写撞车）都返回 null：多命中时不猜，直接当
 * 「无法定位」，由调用方回统一文案。`LIMIT 2` 只为判定歧义，不多取。
 */
export async function findEmailAccount(
  database: D1Database,
  email: string,
): Promise<EmailAccount | null> {
  const rows = await database
    .prepare(
      "SELECT id, email FROM auth_user WHERE lower(email) = ? LIMIT 2",
    )
    .bind(email.trim().toLowerCase())
    .all<EmailAccount>();
  const list = rows.results ?? [];
  return list.length === 1 ? list[0]! : null;
}

/** 该邮箱是否已被某个账号占用（含占位域行）。用于绑定前的占用预检。 */
export async function emailTakenByOther(
  database: D1Database,
  email: string,
  exceptUserId: string,
): Promise<boolean> {
  const row = await database
    .prepare(
      "SELECT id FROM auth_user WHERE lower(email) = ? AND id <> ? LIMIT 1",
    )
    .bind(email.trim().toLowerCase(), exceptUserId)
    .first<{id: string}>();
  return row !== null;
}
