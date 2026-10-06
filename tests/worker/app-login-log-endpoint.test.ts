import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {GET as loginLogsGet} from "@/pages/[adminPath]/ajax/login-logs";
import {recordLoginLog} from "@/server/app-version/login-log";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * End-to-end guard + window tests for the login-log board (ADR-0002).
 *
 * The DB-level dedup and window logic is covered in `app-login-log.test.ts`;
 * what only this file can catch is the HTTP surface — a missing
 * `system:login-log:read` guard, a bound that silently falls back to "unlimited"
 * (an operator would think they were looking at one day), and a response that
 * stops carrying the window it was asked for.
 */

const ORIGIN = "https://feed.example.com";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-04T12:00:00.000Z");

const reader = {
  authUser: {id: "u-login-log"},
  rbacPermissions: new Set([PERMISSION_CODES.SYSTEM_LOGIN_LOG_READ]),
};

async function seedUser(id: string): Promise<void> {
  await env.FEED_DB
    .prepare(
      'INSERT INTO "auth_user" (id, name, email, username, emailVerified, createdAt, updatedAt) ' +
        "VALUES (?, ?, ?, ?, 1, '2024-01-01', '2024-01-01')",
    )
    .bind(id, id.toUpperCase(), `${id}@example.com`, id.replace(/^u-/, ""))
    .run();
}

/** 包含 NOW 当天的窗口，等价于原先的「日」标签。 */
const DAY_WINDOW = {
  from: String(NOW - DAY),
  to: String(NOW + DAY),
};

function call(search: Record<string, string> = {}) {
  const url = new URL(`${ORIGIN}/admin/ajax/login-logs`);
  for (const [key, value] of Object.entries(search)) {
    url.searchParams.set(key, value);
  }
  return loginLogsGet({
    locals: reader,
    request: new Request(url.toString()),
  } as never);
}

beforeEach(async () => {
  await env.FEED_DB.batch([
    env.FEED_DB.prepare("DELETE FROM ext_app_login_log"),
    env.FEED_DB.prepare('DELETE FROM "auth_user"'),
  ]);
  await seedUser("u-login-log");
});

describe("GET /admin/ajax/login-logs", () => {
  it("refuses an unauthenticated caller", async () => {
    const response = await loginLogsGet({
      locals: {},
      request: new Request(`${ORIGIN}/admin/ajax/login-logs`),
    } as never);
    expect(response.status).toBe(401);
  });

  it("refuses a caller without system:login-log:read", async () => {
    const response = await loginLogsGet({
      locals: {
        authUser: {id: "u-login-log"},
        rbacPermissions: new Set([PERMISSION_CODES.SYSTEM_DEVICE_READ]),
      },
      request: new Request(`${ORIGIN}/admin/ajax/login-logs`),
    } as never);
    expect(response.status).toBe(403);
  });

  it("leaves both bounds open when none are given", async () => {
    // 不传任何界限 = 「全区间」，而不是「拒绝」：这是合理的默认（旧版默认最近 1 天，
    // 反而更容易让人误以为日志只有一天的量）。行数上限由 LOGIN_LOG_MAX_ROWS 兜住。
    await recordLoginLog(env.FEED_DB, "u-login-log", "today", NOW);
    await recordLoginLog(
      env.FEED_DB,
      "u-login-log",
      "long-ago",
      NOW - 900 * DAY,
    );
    const response = await call();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {rows: {deviceId: string}[]};
    expect(body.rows.map((row) => row.deviceId).sort()).toEqual([
      "long-ago",
      "today",
    ]);
  });

  it("returns only the devices inside the requested window", async () => {
    await recordLoginLog(env.FEED_DB, "u-login-log", "today", NOW);
    await recordLoginLog(
      env.FEED_DB,
      "u-login-log",
      "six-months-ago",
      NOW - 170 * DAY,
    );

    const today = (await (
      await call(DAY_WINDOW)
    ).json()) as {rows: {deviceId: string}[]};
    expect(today.rows.map((row) => row.deviceId)).toEqual(["today"]);

    const year = (await (
      await call({from: String(NOW - 365 * DAY), to: String(NOW + DAY)})
    ).json()) as {rows: {deviceId: string}[]};
    expect(year.rows.map((row) => row.deviceId).sort()).toEqual([
      "six-months-ago",
      "today",
    ]);
  });

  it("treats the upper bound as exclusive, as listLoginLogs does", async () => {
    // 半开区间 `[from, to)` 的意义：查「某一天」把 to 填到那天之后即可，
    // 不必纠结当天最后一秒；若上界是闭区间，填到同一时刻的行会被漏掉。
    await recordLoginLog(env.FEED_DB, "u-login-log", "at-boundary", NOW);

    const past = (await (
      await call({from: String(NOW - DAY), to: String(NOW + 1)})
    ).json()) as {rows: {deviceId: string}[]};
    expect(past.rows.map((row) => row.deviceId)).toEqual(["at-boundary"]);

    const exactly = (await (
      await call({from: String(NOW - DAY), to: String(NOW)})
    ).json()) as {rows: {deviceId: string}[]};
    expect(exactly.rows).toEqual([]);
  });

  it("joins the account so an operator can tell who was on which device", async () => {
    await recordLoginLog(env.FEED_DB, "u-login-log", "device-1", NOW);
    const body = (await (await call(DAY_WINDOW)).json()) as {
      rows: {
        userId: string | null;
        userName: string | null;
        userEmail: string | null;
      }[];
    };
    expect(body.rows).toHaveLength(1);
    const [row] = body.rows;
    expect(row?.userId).toBe("u-login-log");
    // `displayUsername` wins over `username`, matching the device board's
    // COALESCE — a user who renamed themselves must not show up under the
    // name they abandoned. This row has no `displayUsername`, so the seeded
    // `username` shows through.
    expect(row?.userName).toBe("login-log");
    expect(row?.userEmail).toBe("u-login-log@example.com");
  });

  it("prefers displayUsername over username, as the device board does", async () => {
    await env.FEED_DB
      .prepare('UPDATE "auth_user" SET displayUsername = ? WHERE id = ?')
      .bind("Renamed", "u-login-log")
      .run();
    await recordLoginLog(env.FEED_DB, "u-login-log", "device-1", NOW);
    const body = (await (await call(DAY_WINDOW)).json()) as {
      rows: {userName: string | null}[];
    };
    expect(body.rows[0]?.userName).toBe("Renamed");
  });

  it("rejects a non-numeric bound with 400 instead of quietly ignoring it", async () => {
    // 「传了但看不懂」绝不能等同「没传」：后者是整段放开，看板会假称全区间。
    expect((await call({from: "yesterday"})).status).toBe(400);
    expect((await call({to: "tomorrow"})).status).toBe(400);
  });

  it("rejects a window whose start is later than its end", async () => {
    const response = await call({from: String(NOW), to: String(NOW - DAY)});
    expect(response.status).toBe(400);
  });

  it("never caches the response", async () => {
    const response = await call(DAY_WINDOW);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});
