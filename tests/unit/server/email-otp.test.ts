import {beforeEach, describe, expect, it} from "vitest";
import type {DatabaseSync} from "node:sqlite";

import {
  OTP_DAILY_SEND_LIMIT,
  OTP_IP_WINDOW_MAX,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_INTERVAL_MS,
  OTP_TTL_MS,
  consumeOtp,
  generateEmailOtp,
  hashOtp,
  rateLimitSend,
  storeOtp,
  verifyOtp,
} from "@/server/tcm/email-otp";
import {makeD1, makeSqlite} from "./helpers/d1";

/**
 * 邮箱验证码的生成、存取、校验与限流（ADR §6.1）。
 *
 * 全部跑在真实 SQLite 上，建的是迁移 0153 / 0166 里那两张表的结构：`count`
 * 自增、`ON CONFLICT` 更新窗口、`meta.changes` 判断消费成败，这些都得由真实引擎
 * 给结论，用假对象伪造等于没测。
 */

const SECRET = "test-secret-for-hmac";

const SCHEMA = `
  CREATE TABLE ext_email_otp (
    id TEXT NOT NULL PRIMARY KEY,
    email TEXT NOT NULL,
    purpose TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_sent_at_ms INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL
  );
  CREATE INDEX ext_email_otp_email_purpose_idx ON ext_email_otp (email, purpose);
  CREATE TABLE ext_rate_limit (
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    expires_at_ms INTEGER NOT NULL,
    PRIMARY KEY (kind, key)
  );
`;

const EMAIL = "reader@example.com";

let sqlite: DatabaseSync;
let db: D1Database;
/** 当前这条 OTP 的明文，供校验用例使用（库里只有哈希）。 */
let code: string;

beforeEach(async () => {
  sqlite = makeSqlite(SCHEMA);
  db = makeD1(sqlite);
  code = generateEmailOtp();
  await storeOtp(db, EMAIL, "register", await hashOtp(code, SECRET));
});

function otpRows() {
  return sqlite.prepare("SELECT * FROM ext_email_otp").all() as {
    id: string;
    attempts: number;
    expires_at_ms: number;
  }[];
}

describe("generateEmailOtp", () => {
  it("恒为 6 位数字", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateEmailOtp()).toMatch(/^\d{6}$/u);
    }
  });

  it("不是同一个值重复出现", () => {
    const seen = new Set(Array.from({length: 50}, () => generateEmailOtp()));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("hashOtp", () => {
  it("同一验证码同一密钥得到相同摘要，且为 64 位十六进制", async () => {
    const a = await hashOtp("123456", SECRET);
    const b = await hashOtp("123456", SECRET);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("换密钥或换验证码都得到不同摘要", async () => {
    const base = await hashOtp("123456", SECRET);
    expect(await hashOtp("123456", "another-secret")).not.toBe(base);
    expect(await hashOtp("123457", SECRET)).not.toBe(base);
  });
});

describe("verifyOtp", () => {
  it("校验通过时返回命中行的 id，并且不删除该行", async () => {
    const result = await verifyOtp(db, EMAIL, "register", code, SECRET);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.id).toBe(otpRows()[0]?.id);
    // 预校验不改库：checkout 端点会重复调用，删行会让后面的注册拿不到验证码。
    expect(otpRows()).toHaveLength(1);
  });

  it("可以重复预校验，直到有人显式消费", async () => {
    expect((await verifyOtp(db, EMAIL, "register", code, SECRET)).ok).toBe(true);
    expect((await verifyOtp(db, EMAIL, "register", code, SECRET)).ok).toBe(true);
    expect(otpRows()).toHaveLength(1);
  });

  it("验证码错误时累加 attempts，返回 mismatch", async () => {
    const result = await verifyOtp(db, EMAIL, "register", "000000", SECRET);
    expect(result).toEqual({ok: false, reason: "mismatch"});
    expect(otpRows()[0]?.attempts).toBe(1);
  });

  it("错误次数达到上限后返回 tooManyAttempts，正确验证码也不再放行", async () => {
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i += 1) {
      await verifyOtp(db, EMAIL, "register", "000000", SECRET);
    }
    const result = await verifyOtp(db, EMAIL, "register", code, SECRET);
    expect(result).toEqual({ok: false, reason: "tooManyAttempts"});
  });

  it("过期的验证码返回 expired 并删掉该行", async () => {
    sqlite
      .prepare("UPDATE ext_email_otp SET expires_at_ms = ?")
      .run(Date.now() - 1);
    const result = await verifyOtp(db, EMAIL, "register", code, SECRET);
    expect(result).toEqual({ok: false, reason: "expired"});
    expect(otpRows()).toHaveLength(0);
  });

  it("没有记录时返回 notFound", async () => {
    const result = await verifyOtp(db, "nobody@example.com", "register", code, SECRET);
    expect(result).toEqual({ok: false, reason: "notFound"});
  });

  it("只认最新一条：重新发码后旧码失效", async () => {
    const oldCode = code;
    sqlite.prepare("UPDATE ext_email_otp SET last_sent_at_ms = ?").run(Date.now() - 1000);
    code = generateEmailOtp();
    await storeOtp(db, EMAIL, "register", await hashOtp(code, SECRET));

    expect(await verifyOtp(db, EMAIL, "register", oldCode, SECRET)).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect((await verifyOtp(db, EMAIL, "register", code, SECRET)).ok).toBe(true);
  });

  it("用途隔离：为 register 发的码不能用于 reset", async () => {
    const result = await verifyOtp(db, EMAIL, "reset", code, SECRET);
    expect(result).toEqual({ok: false, reason: "notFound"});
  });
});

describe("consumeOtp", () => {
  it("第一次消费成功，第二次返回 false（并发重复提交只放行一次）", async () => {
    const result = await verifyOtp(db, EMAIL, "register", code, SECRET);
    if (!result.ok) throw new Error("预校验应当通过");

    expect(await consumeOtp(db, result.id)).toBe(true);
    expect(await consumeOtp(db, result.id)).toBe(false);
    expect(otpRows()).toHaveLength(0);
  });

  it("校验通过但不消费时，验证码仍然有效", async () => {
    const result = await verifyOtp(db, EMAIL, "register", code, SECRET);
    if (!result.ok) throw new Error("预校验应当通过");
    expect(otpRows()).toHaveLength(1);
    expect(await consumeOtp(db, result.id)).toBe(true);
  });
});

describe("rateLimitSend", () => {
  it("60 秒内重复发码返回 tooFrequent", async () => {
    const result = await rateLimitSend(db, EMAIL, "register", null);
    expect(result).toEqual({ok: false, reason: "tooFrequent"});
  });

  it("超过重发间隔后放行", async () => {
    sqlite
      .prepare("UPDATE ext_email_otp SET last_sent_at_ms = ?")
      .run(Date.now() - OTP_RESEND_INTERVAL_MS - 1);
    expect(await rateLimitSend(db, EMAIL, "register", null)).toEqual({ok: true});
  });

  it("当日达到上限后返回 dailyLimit", async () => {
    const old = Date.now() - OTP_RESEND_INTERVAL_MS - 1;
    sqlite.prepare("UPDATE ext_email_otp SET last_sent_at_ms = ?").run(old);
    for (let i = 1; i < OTP_DAILY_SEND_LIMIT; i += 1) {
      sqlite
        .prepare(
          "INSERT INTO ext_email_otp (id, email, purpose, code_hash, expires_at_ms, attempts, last_sent_at_ms, created_at_ms) " +
            "VALUES (?, ?, 'register', 'x', ?, 0, ?, ?)",
        )
        .run(`row-${i}`, EMAIL, Date.now() + OTP_TTL_MS, old, Date.now());
    }
    expect(await rateLimitSend(db, EMAIL, "register", null)).toEqual({
      ok: false,
      reason: "dailyLimit",
    });
  });

  it("同一 IP 窗口内超过上限返回 ipLimited", async () => {
    const ip = "203.0.113.9";
    for (let i = 0; i < OTP_IP_WINDOW_MAX; i += 1) {
      expect(await rateLimitSend(db, `user${i}@example.com`, "register", ip)).toEqual({
        ok: true,
      });
    }
    expect(await rateLimitSend(db, "onemore@example.com", "register", ip)).toEqual({
      ok: false,
      reason: "ipLimited",
    });
  });

  it("窗口过去后 IP 计数重置", async () => {
    const ip = "203.0.113.10";
    for (let i = 0; i < OTP_IP_WINDOW_MAX; i += 1) {
      await rateLimitSend(db, `user${i}@example.com`, "register", ip);
    }
    sqlite
      .prepare(
        "UPDATE ext_rate_limit SET expires_at_ms = ? " +
          "WHERE kind = 'email-otp-ip' AND key = ?",
      )
      .run(Date.now() - 3600_000, `email-otp:${ip}`);
    expect(await rateLimitSend(db, "fresh@example.com", "register", ip)).toEqual({ok: true});
  });
});
