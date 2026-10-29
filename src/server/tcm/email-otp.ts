/**
 * 邮箱验证码（OTP）的生成 / 存储 / 校验 / 发码限流（邮箱 + 验证码注册）。
 *
 * 设计要点：
 * - **明文不落库**：D1 只存 HMAC-SHA256(code, BETTER_AUTH_SECRET) 的十六进制摘要，
 *   库泄露也拿不到可用验证码（与 `ext_login_credentials.secret_hash` 同思路）。
 * - **重发即失效**：保留历史行（供当日上限计数），校验只认「未过期的最后一条」
 *   （`ORDER BY last_sent_at_ms DESC LIMIT 1`），所以重新发码后旧码自动作废，
 *   不需要额外的清理任务。
 * - **一次性消费**：改为两步——{@link verifyOtp} 只校验不改行，{@link consumeOtp}
 *   才删行。端点可以「先校验、再做后续检查、最后消费」，这样「邮箱已被占用」
 *   之类的失败不会把用户的验证码白白烧掉。
 * - 参数（6 位 / 10 分钟 / 60s 重发 / 当日 10 次 / 校验 5 次）在此唯一定义，
 *   端点不自行硬编码。
 */

export const OTP_LENGTH = 6;
/** 验证码有效期（毫秒）：10 分钟。 */
export const OTP_TTL_MS = 10 * 60 * 1000;
/** 两次发码最小间隔（毫秒）：60 秒。 */
export const OTP_RESEND_INTERVAL_MS = 60 * 1000;
/** 单邮箱单用途当日发码上限。 */
export const OTP_DAILY_SEND_LIMIT = 10;
/** 单邮箱单用途校验尝试上限，超过则该码作废。 */
export const OTP_MAX_ATTEMPTS = 5;
/** IP 维度窗口（秒）与窗口内上限。 */
export const OTP_IP_WINDOW_SECONDS = 60;
export const OTP_IP_WINDOW_MAX = 20;

/** 校验结果。`id` 是命中的 OTP 行，交给 {@link consumeOtp} 精确定位要删的那一行。 */
export type OtpVerifyResult =
  | {ok: true; id: string}
  | {ok: false; reason: "notFound" | "expired" | "tooManyAttempts" | "mismatch"};

/** 发码前置限流结果。null 表示无限流（可发）。 */
export type OtpSendLimitResult =
  | {ok: true}
  | {ok: false; reason: "tooFrequent" | "dailyLimit" | "ipLimited"};

interface OtpRow {
  id: string;
  code_hash: string;
  expires_at_ms: number;
  attempts: number;
}

/** 生成 6 位数字验证码。用 CSPRNG，不用 Math.random。 */
export function generateEmailOtp(): string {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  const value = (buffer[0] ?? 0) % 1_000_000;
  return String(value).padStart(OTP_LENGTH, "0");
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/** HMAC-SHA256(code, secret) 的十六进制摘要。库里只存这个，不存明文。 */
export async function hashOtp(code: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {hash: "SHA-256", name: "HMAC"},
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(code)),
  );
  return toHex(signature);
}

/**
 * 定长比较（不做长度短路到返回值之外）。
 * 摘要恒为 64 位十六进制，长度相等才逐字节比；长度不等也走完循环再返回 false，
 * 避免通过响应耗时侧信道区分「长度不同」与「内容不同」。
 */
function timingSafeEqual(a: string, b: string): boolean {
  let mismatch = a.length === b.length ? 0 : 1;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

/** 当日零点（毫秒）。Workers 时区为 UTC，「当日」即 UTC 当日，够用且可预测。 */
function startOfTodayMs(nowMs: number): number {
  const date = new Date(nowMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * 写入一条验证码记录。
 * 历史行保留（不删），用于「当日发码上限」计数；旧码因校验只取最新一条而自然失效。
 */
export async function storeOtp(
  database: D1Database,
  email: string,
  purpose: string,
  codeHash: string,
): Promise<void> {
  const now = Date.now();
  await database
    .prepare(
      "INSERT INTO ext_email_otp " +
        "(id, email, purpose, code_hash, expires_at_ms, attempts, last_sent_at_ms, created_at_ms) " +
        "VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
    )
    .bind(
      crypto.randomUUID(),
      email,
      purpose,
      codeHash,
      now + OTP_TTL_MS,
      now,
      now,
    )
    .run();
}

/**
 * 校验验证码，**不改动命中的行**。
 *
 * 失败会累加 `attempts`（mismatch）；过期记录直接删除，避免垃圾行堆积。
 * 校验通过后由调用方决定何时调用 {@link consumeOtp}——「先校验、再查重、最后
 * 消费」让已注册邮箱这类失败不会消耗掉用户的验证码。
 */
export async function verifyOtp(
  database: D1Database,
  email: string,
  purpose: string,
  code: string,
  secret: string,
): Promise<OtpVerifyResult> {
  const now = Date.now();
  const row = await database
    .prepare(
      "SELECT id, code_hash, expires_at_ms, attempts FROM ext_email_otp " +
        "WHERE email = ? AND purpose = ? ORDER BY last_sent_at_ms DESC LIMIT 1",
    )
    .bind(email, purpose)
    .first<OtpRow>();
  if (!row) return {ok: false, reason: "notFound"};

  if (row.expires_at_ms <= now) {
    await database
      .prepare("DELETE FROM ext_email_otp WHERE id = ?")
      .bind(row.id)
      .run();
    return {ok: false, reason: "expired"};
  }

  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    return {ok: false, reason: "tooManyAttempts"};
  }

  const candidate = await hashOtp(code, secret);
  if (!timingSafeEqual(candidate, row.code_hash)) {
    await database
      .prepare("UPDATE ext_email_otp SET attempts = attempts + 1 WHERE id = ?")
      .bind(row.id)
      .run();
    return {ok: false, reason: "mismatch"};
  }

  return {ok: true, id: row.id};
}

/**
 * 删除一条已校验通过的验证码。
 *
 * 返回 false 说明该行已被别的请求删掉（同一码并发提交两次），调用方据此拒绝
 * 第二次建号，而不是把它当成成功。
 */
export async function consumeOtp(
  database: D1Database,
  id: string,
): Promise<boolean> {
  const result = await database
    .prepare("DELETE FROM ext_email_otp WHERE id = ?")
    .bind(id)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * 发码前置限流：重发间隔 → 当日上限 → IP 窗口。
 *
 * IP 维度复用 `ext_auth_throttle`（迁移 0059，与 `auth-endpoint-throttle` 同表同形状：
 * key / attempts / window_start），键 `email-otp:<ip>`。之所以不碰 better-auth 的
 * `auth_rate_limit`——那是上游内置表，写它会给后续上游合并埋冲突点。
 * 命中窗口时顺带自增计数（与既有限流实现一致），被拒时不再自增。
 */
export async function rateLimitSend(
  database: D1Database,
  email: string,
  purpose: string,
  ip: string | null,
): Promise<OtpSendLimitResult> {
  const now = Date.now();

  const latest = await database
    .prepare(
      "SELECT last_sent_at_ms FROM ext_email_otp " +
        "WHERE email = ? AND purpose = ? ORDER BY last_sent_at_ms DESC LIMIT 1",
    )
    .bind(email, purpose)
    .first<{last_sent_at_ms: number}>();
  if (latest && now - latest.last_sent_at_ms < OTP_RESEND_INTERVAL_MS) {
    return {ok: false, reason: "tooFrequent"};
  }

  const countRow = await database
    .prepare(
      "SELECT COUNT(*) AS total FROM ext_email_otp " +
        "WHERE email = ? AND purpose = ? AND created_at_ms >= ?",
    )
    .bind(email, purpose, startOfTodayMs(now))
    .first<{total: number}>();
  if ((countRow?.total ?? 0) >= OTP_DAILY_SEND_LIMIT) {
    return {ok: false, reason: "dailyLimit"};
  }

  if (ip) {
    const key = `email-otp:${ip}`;
    const nowSeconds = Math.floor(now / 1000);
    const windowRow = await database
      .prepare(
        "SELECT attempts, window_start FROM ext_auth_throttle WHERE key = ?",
      )
      .bind(key)
      .first<{attempts: number; window_start: number}>();

    if (
      !windowRow ||
      nowSeconds - windowRow.window_start >= OTP_IP_WINDOW_SECONDS
    ) {
      await database
        .prepare(
          "INSERT INTO ext_auth_throttle (key, attempts, window_start) VALUES (?, 1, ?) " +
            "ON CONFLICT(key) DO UPDATE SET attempts = 1, window_start = excluded.window_start",
        )
        .bind(key, nowSeconds)
        .run();
      return {ok: true};
    }

    if (windowRow.attempts >= OTP_IP_WINDOW_MAX) {
      return {ok: false, reason: "ipLimited"};
    }
    await database
      .prepare(
        "UPDATE ext_auth_throttle SET attempts = attempts + 1 WHERE key = ?",
      )
      .bind(key)
      .run();
  }

  return {ok: true};
}
