/**
 * 邮箱注册时的用户名推导（邮箱 + 验证码注册 §3.5）。
 *
 * `auth_user.username` 有唯一索引，而邮箱的本地部分天然会撞车（`zhang@a.com` 与
 * `zhang@b.com` 都是 `zhang`）。这里的规则是：先用本地部分的净化形态，撞了就
 * 追加 4 位随机后缀重试，仍然撞到第 8 次则用 6 位后缀兜底。
 *
 * 单独成文件是为了能对「撞车后追加后缀」这件事单独验证——它是注册链路上唯一
 * 一处重试循环，埋在建号流程里就没人测得动。
 */

const USERNAME_STRIP = /[^a-z0-9._-]/gu;
const SUFFIX_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
/** 基名上限：与 better-auth `username` 插件的长度约定一致，留出后缀空间。 */
const USERNAME_MAX_BASE = 32;
/** 基名撞车后的重试次数。 */
const USERNAME_ATTEMPTS = 8;

function randomSuffix(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    out += SUFFIX_CHARS[(byte ?? 0) % SUFFIX_CHARS.length];
  }
  return out;
}

/**
 * 邮箱本地部分 → 候选用户名：小写、去掉不允许的字符、截断到上限。
 * 结果为空（本地部分全是非法字符）时回落到 `user`，保证返回值一定可用。
 */
export function baseUsername(email: string): string {
  const localPart = (email.split("@")[0] ?? "").toLowerCase();
  const normalized = localPart.replace(USERNAME_STRIP, "");
  return normalized.slice(0, USERNAME_MAX_BASE) || "user";
}

/**
 * 取一个当前未被占用的用户名。
 *
 * 每次都回查 `auth_user.username`，最后一次兜底用 6 位后缀——即便连续 8 次都撞，
 * 6 位随机后缀（36^6）的碰撞概率也远低于唯一索引抛错的可能性。真正插入时仍有
 * 唯一索引兜底，撞了会被建号流程当作失败处理。
 */
export async function deriveUniqueUsername(
  database: D1Database,
  base: string,
): Promise<string> {
  for (let attempt = 0; attempt < USERNAME_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}${randomSuffix(4)}`;
    const row = await database
      .prepare("SELECT id FROM auth_user WHERE username = ?")
      .bind(candidate)
      .first<{id: string}>();
    if (!row) return candidate;
  }
  return `${base}${randomSuffix(6)}`;
}
