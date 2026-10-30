/**
 * 图形验证码的「一次性」记账（ADR-0015 D2）。
 *
 * `captcha.ts` 的验证码是**无状态**的：`reqNo` 里只有过期时刻 + HMAC 签名，校验
 * 只重算签名、不写任何状态。因此同一张 `(code, reqNo)` 在 TTL（120s）内可以无限
 * 次提交——把它当防枚举门控时，攻击者解一次图就能打满 IP 窗口（20 次/60s）。
 *
 * 本模块只补一件 `captcha.ts` 不该有的事：**记账**。码本身仍然无状态（不落库、
 * 不存明文），落库的只是 `reqNo` 的 SHA-256 摘要，用来判「这张码是不是第一次用」。
 *
 * 与 `email-otp.ts` 的分工：那边管邮件 6 位码，这边管登录/重置页的图形码。
 * 两者都按「先校验、再消费」两步走，失败不烧码的语义一致。
 */

const NONCE_RETENTION_MS = 24 * 60 * 60 * 1000;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  let out = "";
  for (const byte of new Uint8Array(digest)) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * 抢占一张图形验证码的消费权。
 *
 * `true` = 首次使用（调用方可以继续）；`false` = 已被用过（必须拒绝）。
 * 用 `INSERT OR IGNORE` 的 `changes` 判定，与 `consumeOtp` 同一套并发语义：
 * 同一张码并发提交两次，只有一次能拿到 `changes === 1`。
 */
export async function consumeCaptchaOnce(
  database: D1Database,
  reqNo: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const trimmed = reqNo.trim();
  if (!trimmed) return false;
  const result = await database
    .prepare(
      "INSERT OR IGNORE INTO ext_captcha_nonce (req_no_hash, used_at_ms) VALUES (?, ?)",
    )
    .bind(await sha256Hex(trimmed), nowMs)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * 删掉 24 小时前的记账行。
 *
 * 与 `storeOtp` 的清理同一口径（ADR-0015 D16）：不依赖定时任务，在写入路径上
 * 顺带做，幂等。单条 DELETE 走 `ext_captcha_nonce_used_idx`。
 */
export async function cleanupCaptchaNonces(
  database: D1Database,
  nowMs = Date.now(),
): Promise<void> {
  await database
    .prepare("DELETE FROM ext_captcha_nonce WHERE used_at_ms < ?")
    .bind(nowMs - NONCE_RETENTION_MS)
    .run();
}
