import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {insertOnce} from "@/server/rate-limit/once";
import {pruneExpired} from "@/server/rate-limit/prune";
import {
  clearWindow,
  consumeWindow,
  readWindowStatement,
  readWindows,
  recordWindowHit,
  windowAllows,
  type WindowRow,
} from "@/server/rate-limit/window";
import type {WindowRule} from "@/server/rate-limit/kinds";

/**
 * `ext_rate_limit` 的两个原语（迁移 0166 / ADR-0056）。
 *
 * 分类参数用本地规则，不引用生产常量：这里测的是窗口算术与去重语义，
 * 生产参数改动不该让本文件跟着变。五个真实分类的接线由各自的端点测试覆盖。
 */

const RULE: WindowRule = {kind: "auth-throttle", max: 3, windowMs: 60_000};

async function clearAll(): Promise<void> {
  await env.FEED_DB.prepare("DELETE FROM ext_rate_limit").run();
}

describe("consumeWindow", () => {
  beforeEach(clearAll);

  it("窗口内逐次递增，第 max+1 次拒绝", async () => {
    const now = Date.now();
    for (let i = 1; i <= RULE.max; i += 1) {
      expect(await consumeWindow(env.FEED_DB, RULE, "k1", {now}))
        .toMatchObject({allowed: true});
    }
    const rejected = await consumeWindow(env.FEED_DB, RULE, "k1", {now});
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("窗口过去后计数从 1 重新起算", async () => {
    const now = Date.now();
    for (let i = 0; i < RULE.max; i += 1) {
      await consumeWindow(env.FEED_DB, RULE, "k2", {now});
    }
    const later = now + RULE.windowMs + 1;
    expect(await consumeWindow(env.FEED_DB, RULE, "k2", {now: later}))
      .toMatchObject({allowed: true});
    const row = await readWindowStatement(env.FEED_DB, RULE.kind, "k2")
      .first<WindowRow>();
    expect(row?.count).toBe(1);
    expect(Number(row?.expires_at_ms)).toBe(later + RULE.windowMs);
  });

  it("达上限的拒绝路径不写库", async () => {
    const now = Date.now();
    for (let i = 0; i < RULE.max; i += 1) {
      await consumeWindow(env.FEED_DB, RULE, "k3", {now});
    }
    const before = await readWindowStatement(env.FEED_DB, RULE.kind, "k3")
      .first<WindowRow>();
    await consumeWindow(env.FEED_DB, RULE, "k3", {now});
    const after = await readWindowStatement(env.FEED_DB, RULE.kind, "k3")
      .first<WindowRow>();
    expect(after).toEqual(before);
  });

  it("不同 kind 的同名键互不影响", async () => {
    const now = Date.now();
    await consumeWindow(env.FEED_DB, RULE, "shared", {now});
    await consumeWindow(
      env.FEED_DB,
      {...RULE, kind: "app-quota"},
      "shared",
      {now},
    );
    const throttled = await readWindows(env.FEED_DB, RULE.kind, ["shared"]);
    const quota = await readWindows(env.FEED_DB, "app-quota", ["shared"]);
    expect(throttled.get("shared")?.count).toBe(1);
    expect(quota.get("shared")?.count).toBe(1);
  });
});

describe("windowAllows", () => {
  it("没有行、窗口已过期、次数未满都允许", () => {
    const now = Date.now();
    expect(windowAllows(null, 3, now)).toBe(true);
    expect(windowAllows({count: 9, expires_at_ms: now - 1}, 3, now)).toBe(true);
    expect(windowAllows({count: 2, expires_at_ms: now + 1000}, 3, now)).toBe(true);
    expect(windowAllows({count: 3, expires_at_ms: now + 1000}, 3, now)).toBe(false);
  });
});

describe("recordWindowHit / clearWindow", () => {
  beforeEach(clearAll);

  it("只记一次，不做上限判定", async () => {
    const now = Date.now();
    for (let i = 0; i < RULE.max + 2; i += 1) {
      await recordWindowHit(env.FEED_DB, RULE, "k4", {now});
    }
    const row = await readWindowStatement(env.FEED_DB, RULE.kind, "k4")
      .first<WindowRow>();
    expect(row?.count).toBe(RULE.max + 2);
  });

  it("清空后重新允许", async () => {
    const now = Date.now();
    for (let i = 0; i < RULE.max; i += 1) {
      await consumeWindow(env.FEED_DB, RULE, "k5", {now});
    }
    expect((await consumeWindow(env.FEED_DB, RULE, "k5", {now})).allowed).toBe(false);
    await clearWindow(env.FEED_DB, RULE.kind, "k5");
    expect((await consumeWindow(env.FEED_DB, RULE, "k5", {now})).allowed).toBe(true);
  });
});

describe("insertOnce", () => {
  beforeEach(clearAll);

  it("首次插入成功，重复键返回 false", async () => {
    const expiresAt = Date.now() + 60_000;
    expect(await insertOnce(env.FEED_DB, "replay-nonce", "n1", expiresAt)).toBe(true);
    expect(await insertOnce(env.FEED_DB, "replay-nonce", "n1", expiresAt)).toBe(false);
  });

  it("不同 kind 的同名键各算一次", async () => {
    const expiresAt = Date.now() + 60_000;
    expect(await insertOnce(env.FEED_DB, "replay-nonce", "n2", expiresAt)).toBe(true);
    expect(await insertOnce(env.FEED_DB, "captcha-nonce", "n2", expiresAt)).toBe(true);
  });
});

describe("pruneExpired", () => {
  beforeEach(clearAll);

  it("只删已过期的行", async () => {
    const now = Date.now();
    await insertOnce(env.FEED_DB, "captcha-nonce", "old", now - 1);
    await insertOnce(env.FEED_DB, "captcha-nonce", "fresh", now + 60_000);
    await pruneExpired(env.FEED_DB, now);
    const rows = await readWindows(env.FEED_DB, "captcha-nonce", ["old", "fresh"]);
    expect(rows.has("old")).toBe(false);
    expect(rows.has("fresh")).toBe(true);
  });
});
