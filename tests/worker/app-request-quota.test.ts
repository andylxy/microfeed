import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {
  APP_REQUEST_QUOTA_MAX,
  appQuotaExhaustedMarker,
  appRequestQuotaResponse,
  consumeAppRequestQuota,
  consumeAppRequestQuotaFromRow,
  markQuotaExhausted,
  quotaSelectStatement,
  readAppRequestQuotaRows,
  type AppRequestQuotaRow,
} from "@/server/rbac/app-quota";

/**
 * App 内容端点按凭证限流（ADR-0048 / F3）的模块行为：窗口递增、达上限拒绝、
 * 窗口翻转重置、边界请求放行、429 信封形状、Cache 标记读写。
 * middleware 的挂载顺序（标记先于防重放、计数后于版本门）见 middleware 接线。
 */
const CREDENTIAL_ID = "cred-quota-test";

async function seedQuotaRow(
  credentialId: string,
  count: number,
  resetAtMs: number,
): Promise<void> {
  await env.FEED_DB.prepare(
    "INSERT OR REPLACE INTO ext_app_request_quota " +
      "(credential_id, count, reset_at_ms) VALUES (?, ?, ?)",
  ).bind(credentialId, count, resetAtMs).run();
}

describe("app request quota", () => {
  beforeEach(async () => {
    await env.FEED_DB.prepare("DELETE FROM ext_app_request_quota").run();
  });

  it("counts up within a window", async () => {
    const now = Date.now();
    const first = await consumeAppRequestQuota(env.FEED_DB, CREDENTIAL_ID, {now});
    expect(first).toMatchObject({allowed: true});
    const second = await consumeAppRequestQuota(
      env.FEED_DB,
      CREDENTIAL_ID,
      {now: now + 1000},
    );
    expect(second).toMatchObject({allowed: true});
    const rows = await readAppRequestQuotaRows(env.FEED_DB, [CREDENTIAL_ID]);
    expect(rows.get(CREDENTIAL_ID)?.count).toBe(2);
  });

  it("rejects with a retry hint once the window is exhausted", async () => {
    const now = Date.now();
    await seedQuotaRow(CREDENTIAL_ID, APP_REQUEST_QUOTA_MAX, now + 60_000);
    const decision = await consumeAppRequestQuota(env.FEED_DB, CREDENTIAL_ID, {now});
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
    expect(decision.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("rejects from a prefetched row without writing a row", async () => {
    // 合批后（方案 6）中间的 SELECT 由批次二取回，UPSERT 仍单独执行。达上限时
    // 必须直接拒绝且不写库——拒绝路径的 D1 写代价为零是模块的头号约束。
    const now = Date.now();
    const resetAtMs = now + 60_000;
    await seedQuotaRow(CREDENTIAL_ID, APP_REQUEST_QUOTA_MAX, resetAtMs);
    const row = await quotaSelectStatement(env.FEED_DB, CREDENTIAL_ID)
      .first<AppRequestQuotaRow>();
    expect(row).not.toBeNull();
    const decision = await consumeAppRequestQuotaFromRow(
      env.FEED_DB,
      CREDENTIAL_ID,
      row,
      {now},
    );
    expect(decision).toMatchObject({allowed: false});
    const rows = await readAppRequestQuotaRows(env.FEED_DB, [CREDENTIAL_ID]);
    expect(rows.get(CREDENTIAL_ID)).toEqual({
      count: APP_REQUEST_QUOTA_MAX,
      resetAtMs,
    });
  });

  it("restarts the counter when the previous window lapsed", async () => {
    const now = Date.now();
    await seedQuotaRow(CREDENTIAL_ID, APP_REQUEST_QUOTA_MAX, now - 1);
    const decision = await consumeAppRequestQuota(env.FEED_DB, CREDENTIAL_ID, {now});
    expect(decision).toMatchObject({allowed: true});
    const rows = await readAppRequestQuotaRows(env.FEED_DB, [CREDENTIAL_ID]);
    expect(rows.get(CREDENTIAL_ID)?.count).toBe(1);
    expect(rows.get(CREDENTIAL_ID)?.resetAtMs).toBeGreaterThan(now);
  });

  it("allows the boundary request and rejects the next one past the cap", async () => {
    const now = Date.now();
    await seedQuotaRow(CREDENTIAL_ID, APP_REQUEST_QUOTA_MAX - 1, now + 60_000);
    const boundary = await consumeAppRequestQuota(env.FEED_DB, CREDENTIAL_ID, {now});
    expect(boundary.allowed).toBe(true);
    const past = await consumeAppRequestQuota(
      env.FEED_DB,
      CREDENTIAL_ID,
      {now: now + 1000},
    );
    expect(past.allowed).toBe(false);
  });

  it("serves a 429 in the legacy envelope with Retry-After", async () => {
    const response = appRequestQuotaResponse(37);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("37");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      code: 429,
      data: null,
    });
  });

  it("marks exhaustion in the worker cache so later requests skip D1", async () => {
    const token = "mflc_quota_marker_test";
    const resetAt = Date.now() + 120_000;
    await markQuotaExhausted(token, resetAt);
    const retryAfter = await appQuotaExhaustedMarker(token);
    expect(retryAfter).not.toBeNull();
    expect(retryAfter ?? 0).toBeGreaterThan(0);
    expect(retryAfter ?? 0).toBeLessThanOrEqual(120);
    // 另一把 token 没有标记：标记按 token 哈希分键。
    expect(await appQuotaExhaustedMarker("mflc_other")).toBeNull();
  });
});
