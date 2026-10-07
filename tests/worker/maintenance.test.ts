import {env} from "cloudflare:workers";
import {afterEach, describe, expect, it} from "vitest";

import {pruneRetainedLogs} from "@/server/maintenance";

const USER_ID = "prune-user-1";
const NOW = Date.parse("2026-06-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

async function cleanup() {
  await env.FEED_DB.batch([
    env.FEED_DB.prepare("DELETE FROM auth_session WHERE id LIKE 'prune-%'"),
    env.FEED_DB.prepare("DELETE FROM ext_api_access_log WHERE id LIKE 'prune-%'"),
    env.FEED_DB.prepare("DELETE FROM ext_app_login_log WHERE id LIKE 'prune-%'"),
    env.FEED_DB.prepare("DELETE FROM auth_user WHERE id = ?").bind(USER_ID),
  ]);
}

afterEach(cleanup);

describe("pruneRetainedLogs", () => {
  it("drops expired sessions and out-of-window logs, keeps fresh rows", async () => {
    await cleanup();
    await env.FEED_DB.prepare(
      "INSERT INTO auth_user (id, name, email, emailVerified, createdAt, updatedAt) " +
        "VALUES (?, 'prune', 'prune@example.com', 0, '2026-01-01', '2026-01-01')",
    ).bind(USER_ID).run();
    await env.FEED_DB.batch([
      env.FEED_DB.prepare(
        "INSERT INTO auth_session (id, expiresAt, token, createdAt, updatedAt, userId) " +
          "VALUES ('prune-expired', '2026-05-01T00:00:00.000Z', 't1', '2026-01-01', '2026-01-01', ?)",
      ).bind(USER_ID),
      env.FEED_DB.prepare(
        "INSERT INTO auth_session (id, expiresAt, token, createdAt, updatedAt, userId) " +
          "VALUES ('prune-active', '2026-07-01T00:00:00.000Z', 't2', '2026-01-01', '2026-01-01', ?)",
      ).bind(USER_ID),
      env.FEED_DB.prepare(
        "INSERT INTO ext_api_access_log (id, user_id, method, path, permission_code, granted, status, created_at_ms) " +
          "VALUES ('prune-api-old', ?, 'GET', '/x', 'p', 1, 200, ?)",
      ).bind(USER_ID, NOW - 200 * DAY),
      env.FEED_DB.prepare(
        "INSERT INTO ext_api_access_log (id, user_id, method, path, permission_code, granted, status, created_at_ms) " +
          "VALUES ('prune-api-new', ?, 'GET', '/x', 'p', 1, 200, ?)",
      ).bind(USER_ID, NOW - 1 * DAY),
      env.FEED_DB.prepare(
        "INSERT INTO ext_app_login_log (id, user_id, device_id, log_date, login_at, login_count, created_at) " +
          "VALUES ('prune-login-old', ?, 'd1', '2025-01-01', ?, 1, ?)",
      ).bind(USER_ID, new Date(NOW - 200 * DAY).toISOString(), "2025-01-01"),
      env.FEED_DB.prepare(
        "INSERT INTO ext_app_login_log (id, user_id, device_id, log_date, login_at, login_count, created_at) " +
          "VALUES ('prune-login-new', ?, 'd2', '2026-05-31', ?, 1, ?)",
      ).bind(USER_ID, new Date(NOW - 1 * DAY).toISOString(), "2026-05-31"),
    ]);

    await pruneRetainedLogs(env.FEED_DB, NOW);

    const ids = async (table: string) =>
      (await env.FEED_DB.prepare(
        `SELECT id FROM ${table} WHERE id LIKE 'prune-%' ORDER BY id`,
      ).all<{id: string}>()).results.map((row) => row.id);
    expect(await ids("auth_session")).toEqual(["prune-active"]);
    expect(await ids("ext_api_access_log")).toEqual(["prune-api-new"]);
    expect(await ids("ext_app_login_log")).toEqual(["prune-login-new"]);
  });
});
