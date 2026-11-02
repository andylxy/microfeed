/**
 * 限流分类与窗口参数（唯一真相来源）。
 *
 * 五个分类共用一张 `ext_rate_limit`（迁移 0166）。`kind` 是主键的一部分，
 * 分类隔离由 schema 保证，不靠 key 字符串前缀约定。
 *
 * 两类语义能共用一张表，依据只有一条：一行在 `expires_at_ms` 之后无意义。
 * - 窗口计数器：`expires_at_ms` 是窗口终点，翻转时原地把 `count` 重置为 1；
 * - 一次性台账：`count` 恒为 1，`expires_at_ms` 是保留终点，过期后不再判重。
 *
 * 参数只在这里改。调用方按分类引用，不各自写数字。
 */

export type RateLimitKind =
  | "app-quota"
  | "auth-throttle"
  | "bind-quota"
  | "captcha-nonce"
  | "email-otp-ip"
  | "login-failure"
  | "replay-nonce";

/** 固定窗口计数器的规则。 */
export interface WindowRule {
  kind: RateLimitKind;
  /** 窗口内允许的次数上限。 */
  max: number;
  /** 窗口长度（毫秒）。 */
  windowMs: number;
}

/** 一次性台账的规则：只保留，不计数。 */
export interface OnceRule {
  kind: RateLimitKind;
  /** 从写入时刻起的保留时长（毫秒）。 */
  retentionMs: number;
}

/** 登录端点按 IP + 路径限流：5 次 / 60s（A6）。 */
export const AUTH_THROTTLE: WindowRule = {
  kind: "auth-throttle",
  max: 5,
  windowMs: 60_000,
};

/** App 内容端点按登录凭证限流：10,000 次 / 24h（ADR-0048 / F3）。 */
export const APP_QUOTA: WindowRule = {
  kind: "app-quota",
  max: 10_000,
  windowMs: 24 * 60 * 60 * 1000,
};

/** 凭证登录失败计数：10 次 / 60s，登录成功即清空。 */
export const LOGIN_FAILURE: WindowRule = {
  kind: "login-failure",
  max: 10,
  windowMs: 60_000,
};

/**
 * 每账号每日绑定发码配额：10 次 / 24h（ADR-0015 F24）。
 *
 * 与 `AUTH_THROTTLE` 共用过一张表（键前缀 `bind-email-day:`），窗口却是 24h——
 * 这正是合并前「一张表三种窗口、靠 key 前缀区分」的典型。现在它是独立分类。
 */
export const BIND_QUOTA: WindowRule = {
  kind: "bind-quota",
  max: 10,
  windowMs: 24 * 60 * 60 * 1000,
};

/** 邮箱验证码发码的 IP 维度限流：20 次 / 60s。 */
export const EMAIL_OTP_IP: WindowRule = {
  kind: "email-otp-ip",
  max: 20,
  windowMs: 60_000,
};

/** 防重放 nonce：与 `X-Timestamp` 的 ±5 分钟窗口同长。 */
export const REPLAY_NONCE: OnceRule = {
  kind: "replay-nonce",
  retentionMs: 5 * 60 * 1000,
};

/** 图形验证码一次性记账：保留 24h 供判重。 */
export const CAPTCHA_NONCE: OnceRule = {
  kind: "captcha-nonce",
  retentionMs: 24 * 60 * 60 * 1000,
};
