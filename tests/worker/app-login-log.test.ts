import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {
  isLoginLogRange,
  listLoginLogs,
  LOGIN_LOG_RANGES,
  type LoginLogRow,
  recordLoginLog,
} from "@/server/app-version/login-log";

/**
 * ADR-0002 (需求 3): one login row per device per calendar day, queried through
 * six rolling time tags.
 *
 * The two properties worth locking down here are the dedup key and the window
 * comparison. Both were chosen over the obvious alternative and are easy to
 * regress silently:
 *
 * - dedup on `(device_id, log_date)`, **not** per user — so one person on two
 *   phones produces two rows, which is what "找出启动的 App" needs;
 * - the window filters on `login_at`, never on the `log_date` string, so a
 *   timezone cannot push a device across a boundary.
 */

const db = env.FEED_DB;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-04T12:00:00.000Z");

async function seedUser(id: string): Promise<void> {
  await db
    .prepare(
      'INSERT INTO "auth_user" (id, name, email, username, emailVerified, createdAt, updatedAt) ' +
        "VALUES (?, ?, ?, ?, 1, '2024-01-01', '2024-01-01')",
    )
    .bind(id, id.toUpperCase(), `${id}@example.com`, id)
    .run();
}

/** `noUncheckedIndexedAccess` 下 `rows[0]` 是 possibly-undefined；断言非空后交给调用方。 */
function only(rows: LoginLogRow[]): LoginLogRow {
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (!row) throw new Error("expected exactly one login-log row");
  return row;
}

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM ext_app_login_log"),
    db.prepare('DELETE FROM "auth_user"'),
  ]);
});

describe("recordLoginLog", () => {
  it("keeps one row per device per day and counts every login", async () => {
    await seedUser("user-a");
    await recordLoginLog(db, "user-a", "device-1", NOW);
    await recordLoginLog(db, "user-a", "device-1", NOW + 60_000);
    await recordLoginLog(db, "user-a", "device-1", NOW + 3 * 60 * 60 * 1000);

    const rows = await listLoginLogs(db, "day", 50, NOW + 3 * 60 * 60 * 1000);
    expect(rows).toHaveLength(1);
    const row = only(rows);
    expect(row.deviceId).toBe("device-1");
    // 需求 3 追加：同一行累加，不新增行。
    expect(row.loginCount).toBe(3);
  });

  it("records each device separately even for the same account", async () => {
    await seedUser("user-a");
    await recordLoginLog(db, "user-a", "device-1", NOW);
    await recordLoginLog(db, "user-a", "device-2", NOW);

    const rows = await listLoginLogs(db, "day", 50, NOW);
    expect(rows.map((row) => row.deviceId).sort()).toEqual([
      "device-1",
      "device-2",
    ]);
    // 每台设备各自计数，互不影响。
    expect(rows.every((row) => row.loginCount === 1)).toBe(true);
  });

  it("adds a new row the next day for the same device", async () => {
    await recordLoginLog(db, null, "device-1", NOW);
    await recordLoginLog(db, null, "device-1", NOW + DAY);

    const rows = await listLoginLogs(db, "week", 50, NOW + DAY);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.logDate)).size).toBe(2);
    // 计数按天归零：新的一天是新的一行，从 1 开始。
    expect(rows.every((row) => row.loginCount === 1)).toBe(true);
  });

  it("keeps the LAST login time of the day, not the first", async () => {
    // 需求 3 追加：「更新最后登录时间」。0084 原本保留当天第一次（DO NOTHING），
    // 现在改为每次覆盖 —— 与「登录次数 +1」同属一次语义变化。
    await recordLoginLog(db, null, "device-1", NOW);
    await recordLoginLog(db, null, "device-1", NOW + 5 * 60 * 60 * 1000);

    const row = only(await listLoginLogs(db, "day", 50, NOW + 5 * 60 * 60 * 1000));
    expect(row.loginAt).toBe("2026-10-04T17:00:00.000Z");
    expect(row.loginCount).toBe(2);
  });

  it("fills in the user when the day's first login was anonymous", async () => {
    // 同一天先匿名启动、后登录很常见；不该因为先来的是匿名行就永久丢掉归属。
    await seedUser("user-a");
    await recordLoginLog(db, null, "device-1", NOW);
    await recordLoginLog(db, "user-a", "device-1", NOW + 60_000);

    const row = only(await listLoginLogs(db, "day", 50, NOW));
    expect(row.userId).toBe("user-a");
    expect(row.userName).toBe("user-a");
    expect(row.loginCount).toBe(2);
  });

  it("records an anonymous device, which is the whole point of the move", async () => {
    // 写入点已从「设备登记（鉴权之后）」移到匿名的 `GET /api/app/version`，
    // 所以未登录启动也会留下痕迹 —— 这正是「找出启动过的 App」要覆盖的部分。
    await recordLoginLog(db, null, "device-anon", NOW);
    const rows = await listLoginLogs(db, "day", 50, NOW);
    const row = only(rows);
    expect(row.userId).toBeNull();
    expect(row.userName).toBeNull();
    expect(row.loginCount).toBe(1);
  });

  it("does not collide ids for device ids differing only by '-' vs '_'", async () => {
    // 回归防护：朴素规范化（`replace(/[^A-Za-z0-9_]/g, "_")`）会把 `a-b` 与 `a_b`
    // 折成同一个 id → 第二个 INSERT 撞 PRIMARY KEY(id)；而表上的
    // `ON CONFLICT (device_id, log_date)` 只覆盖 UNIQUE 索引、不覆盖主键 →
    // 语句抛错，且 registerUserDevice 无 try，异常冒到鉴权链路变成 500。
    // deviceIdFromRequest 的 `^[A-Za-z0-9_-]+$` 明确允许这两种字符。
    await recordLoginLog(db, null, "a-b", NOW);
    await recordLoginLog(db, null, "a_b", NOW);
    await recordLoginLog(db, null, "a--b", NOW);
    await recordLoginLog(db, null, "a__b", NOW);

    const rows = await listLoginLogs(db, "day", 50, NOW);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row.deviceId)).size).toBe(4);
  });

  it("keeps ids unique for ids that could collide after escaping", async () => {
    // `_` → `__` 是转义的前提：未转义时 `a_` 与 `a` 的编码会前缀重叠。
    await recordLoginLog(db, null, "a", NOW);
    await recordLoginLog(db, null, "a_", NOW);
    await recordLoginLog(db, null, "a__", NOW);

    const rows = await listLoginLogs(db, "day", 50, NOW);
    expect(new Set(rows.map((row) => row.deviceId)).size).toBe(3);
  });

  it("tolerates a 64-char device id at the validation limit", async () => {
    // deviceIdFromRequest 允许长度 ≤ 64；长 id 不得再次放大碰撞面。
    const long = "d".repeat(64);
    await recordLoginLog(db, null, long, NOW);
    await recordLoginLog(db, null, `${long}x`, NOW);

    const rows = await listLoginLogs(db, "day", 50, NOW);
    expect(new Set(rows.map((row) => row.deviceId)).size).toBe(2);
  });
});

describe("listLoginLogs time tags", () => {
  it("only returns devices inside the selected window", async () => {
    await recordLoginLog(db, null, "today", NOW);
    // 80 days back: inside 最近三个月 (90d) but outside 月 (30d).
    await recordLoginLog(db, null, "two-months-ago", NOW - 80 * DAY);
    // 100 days back: outside 最近三个月 — the boundary the window must enforce.
    await recordLoginLog(db, null, "outside-quarter", NOW - 100 * DAY);
    await recordLoginLog(db, null, "two-years-ago", NOW - 800 * DAY);

    const week = await listLoginLogs(db, "week", 50, NOW);
    expect(week.map((row) => row.deviceId)).toEqual(["today"]);

    const month = await listLoginLogs(db, "month", 50, NOW);
    expect(month.map((row) => row.deviceId)).toEqual(["today"]);

    const quarter = await listLoginLogs(db, "quarter", 50, NOW);
    expect(quarter.map((row) => row.deviceId).sort()).toEqual([
      "today",
      "two-months-ago",
    ]);

    const year = await listLoginLogs(db, "year", 50, NOW);
    expect(year).toHaveLength(3);
  });

  it("orders newest first", async () => {
    await recordLoginLog(db, null, "old", NOW - 2 * DAY);
    await recordLoginLog(db, null, "new", NOW - 1 * DAY);

    const rows = await listLoginLogs(db, "week", 50, NOW);
    expect(rows.map((row) => row.deviceId)).toEqual(["new", "old"]);
  });

  it("exposes the six ADR-0002 tags with widening windows", async () => {
    expect(LOGIN_LOG_RANGES).toEqual({
      day: 1,
      week: 7,
      month: 30,
      quarter: 90,
      halfYear: 182,
      year: 365,
    });
  });

  it("rejects an unknown tag instead of silently falling back", () => {
    expect(isLoginLogRange("quarter")).toBe(true);
    expect(isLoginLogRange("day")).toBe(true);
    expect(isLoginLogRange("decade")).toBe(false);
    expect(isLoginLogRange("toString")).toBe(false);
  });
});
