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
 * `system:login-log:read` guard, a range parameter that silently falls back to
 * "day" (an operator would think they were looking at a year), and a response
 * that stops carrying the window it was asked for.
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

function call(range: string | null) {
  const url = new URL(`${ORIGIN}/admin/ajax/login-logs`);
  if (range !== null) url.searchParams.set("range", range);
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
      request: new Request(`${ORIGIN}/admin/ajax/login-logs?range=day`),
    } as never);
    expect(response.status).toBe(401);
  });

  it("refuses a caller without system:login-log:read", async () => {
    const response = await loginLogsGet({
      locals: {
        authUser: {id: "u-login-log"},
        rbacPermissions: new Set([PERMISSION_CODES.SYSTEM_DEVICE_READ]),
      },
      request: new Request(`${ORIGIN}/admin/ajax/login-logs?range=day`),
    } as never);
    expect(response.status).toBe(403);
  });

  it("defaults to the day window when no range is given", async () => {
    const response = await call(null);
    expect(response.status).toBe(200);
    const body = await response.json() as {range: string; days: number};
    expect(body.range).toBe("day");
    expect(body.days).toBe(1);
  });

  it("serves each of the six ADR-0002 tags with its own window", async () => {
    await recordLoginLog(env.FEED_DB, "u-login-log", "today", NOW);
    await recordLoginLog(env.FEED_DB, "u-login-log", "six-months-ago", NOW - 170 * DAY);

    const expected: Record<string, {days: number; ids: string[]}> = {
      day: {days: 1, ids: ["today"]},
      week: {days: 7, ids: ["today"]},
      month: {days: 30, ids: ["today"]},
      quarter: {days: 90, ids: ["today"]},
      halfYear: {days: 182, ids: ["six-months-ago", "today"]},
      year: {days: 365, ids: ["six-months-ago", "today"]},
    };

    for (const [range, want] of Object.entries(expected)) {
      const response = await call(range);
      expect(response.status).toBe(200);
      const body = await response.json() as {
        range: string;
        days: number;
        rows: {deviceId: string; userName: string | null}[];
      };
      expect(body.range).toBe(range);
      expect(body.days).toBe(want.days);
      expect(body.rows.map((row) => row.deviceId).sort()).toEqual(want.ids);
    }
  });

  it("joins the account so an operator can tell who was on which device", async () => {
    await recordLoginLog(env.FEED_DB, "u-login-log", "device-1", NOW);
    const body = await (await call("day")).json() as {
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
    const body = await (await call("day")).json() as {
      rows: {userName: string | null}[];
    };
    expect(body.rows[0]?.userName).toBe("Renamed");
  });

  it("rejects an unknown tag with 400 instead of quietly showing a day", async () => {
    const response = await call("decade");
    expect(response.status).toBe(400);
  });

  it("never caches the response", async () => {
    const response = await call("day");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});
