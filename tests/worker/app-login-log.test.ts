import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {
  type LoginLogRow,
  type LoginLogWindow,
  listLoginLogs,
  recordLoginLog,
} from "@/server/app-version/login-log";

/**
 * ADR-0002 (需求 3): one login row per device per calendar day, queried through
 * a `[fromMs, toMs)` window on `login_at`.
 *
 * The three properties worth locking down here are the dedup key, the window
 * comparison, and the account columns. Each was chosen over the obvious
 * alternative and is easy to regress silently:
 *
 * - dedup on `(device_id, log_date)`, **not** per user — so one person on two
 *   phones produces two rows, which is what "找出启动的 App" needs;
 * - the window filters on `login_at`, never on the `log_date` string, so a
 *   timezone cannot push a device across a boundary;
 * - `userId` survives an account with no username. A board that only reads
 *   `userName` will label every such row "未登录" even though the account is
 *   right there — which is exactly what happened.
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

/** 「最近 N 天」：以某个时刻为界往回 N 天，上界放开。 */
function since(now: number, days: number): LoginLogWindow {
  return {fromMs: now - days * DAY};
}

/** 一条「账号 ↔ 设备」绑定；`ext_user_devices` 的主键是 (user_id, device_id)。 */
async function bindDevice(
  userId: string,
  deviceId: string,
  seenAt: number,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO ext_user_devices (user_id, device_id, last_seen_at, status) " +
        "VALUES (?, ?, ?, 'active')",
    )
    .bind(userId, deviceId, new Date(seenAt).toISOString())
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
  // `ext_user_devices` 的行随 `auth_user` 级联删除，这里显式清一遍是为了让
  // 「设备绑定」相关的断言不依赖级联是否生效。
  await db.batch([
    db.prepare("DELETE FROM ext_app_login_log"),
    db.prepare("DELETE FROM ext_user_devices"),
    db.prepare('DELETE FROM "auth_user"'),
  ]);
});

describe("recordLoginLog", () => {
  it("keeps one row per device per day and counts every login", async () => {
    await seedUser("user-a");
    await recordLoginLog(db, "user-a", "device-1", NOW);
    await recordLoginLog(db, "user-a", "device-1", NOW + 60_000);
    await recordLoginLog(db, "user-a", "device-1", NOW + 3 * 60 * 60 * 1000);

    const rows = await listLoginLogs(db, since(NOW + 3 * 60 * 60 * 1000, 1), 50);
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

    const rows = await listLoginLogs(db, since(NOW, 1), 50);
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

    const rows = await listLoginLogs(db, since(NOW + DAY, 7), 50);
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

    const row = only(await listLoginLogs(db, since(NOW + 5 * 60 * 60 * 1000, 1), 50));
    expect(row.loginAt).toBe("2026-10-04T17:00:00.000Z");
    expect(row.loginCount).toBe(2);
  });

  it("fills in the user when the day's first login was anonymous", async () => {
    // 同一天先匿名启动、后登录很常见；不该因为先来的是匿名行就永久丢掉归属。
    await seedUser("user-a");
    await recordLoginLog(db, null, "device-1", NOW);
    await recordLoginLog(db, "user-a", "device-1", NOW + 60_000);

    const row = only(await listLoginLogs(db, since(NOW, 1), 50));
    expect(row.userId).toBe("user-a");
    expect(row.userName).toBe("user-a");
    expect(row.loginCount).toBe(2);
  });

  it("records an anonymous device, which is the whole point of the move", async () => {
    // 写入点已从「设备登记（鉴权之后）」移到匿名的 `GET /api/app/version`，
    // 所以未登录启动也会留下痕迹 —— 这正是「找出启动过的 App」要覆盖的部分。
    await recordLoginLog(db, null, "device-anon", NOW);
    const rows = await listLoginLogs(db, since(NOW, 1), 50);
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

    const rows = await listLoginLogs(db, since(NOW, 1), 50);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row.deviceId)).size).toBe(4);
  });

  it("keeps ids unique for ids that could collide after escaping", async () => {
    // `_` → `__` 是转义的前提：未转义时 `a_` 与 `a` 的编码会前缀重叠。
    await recordLoginLog(db, null, "a", NOW);
    await recordLoginLog(db, null, "a_", NOW);
    await recordLoginLog(db, null, "a__", NOW);

    const rows = await listLoginLogs(db, since(NOW, 1), 50);
    expect(new Set(rows.map((row) => row.deviceId)).size).toBe(3);
  });

  it("tolerates a 64-char device id at the validation limit", async () => {
    // deviceIdFromRequest 允许长度 ≤ 64；长 id 不得再次放大碰撞面。
    const long = "d".repeat(64);
    await recordLoginLog(db, null, long, NOW);
    await recordLoginLog(db, null, `${long}x`, NOW);

    const rows = await listLoginLogs(db, since(NOW, 1), 50);
    expect(new Set(rows.map((row) => row.deviceId)).size).toBe(2);
  });
});

describe("listLoginLogs window", () => {
  it("only returns devices inside the selected window", async () => {
    await recordLoginLog(db, null, "today", NOW);
    // 80 days back: inside 最近三个月 (90d) but outside 月 (30d).
    await recordLoginLog(db, null, "two-months-ago", NOW - 80 * DAY);
    // 100 days back: outside 最近三个月 — the boundary the window must enforce.
    await recordLoginLog(db, null, "outside-quarter", NOW - 100 * DAY);
    await recordLoginLog(db, null, "two-years-ago", NOW - 800 * DAY);

    const week = await listLoginLogs(db, since(NOW, 7), 50);
    expect(week.map((row) => row.deviceId)).toEqual(["today"]);

    const month = await listLoginLogs(db, since(NOW, 30), 50);
    expect(month.map((row) => row.deviceId)).toEqual(["today"]);

    const quarter = await listLoginLogs(db, since(NOW, 90), 50);
    expect(quarter.map((row) => row.deviceId).sort()).toEqual([
      "today",
      "two-months-ago",
    ]);

    const year = await listLoginLogs(db, since(NOW, 365), 50);
    expect(year).toHaveLength(3);
  });

  it("orders newest first", async () => {
    await recordLoginLog(db, null, "old", NOW - 2 * DAY);
    await recordLoginLog(db, null, "new", NOW - 1 * DAY);

    const rows = await listLoginLogs(db, since(NOW, 7), 50);
    expect(rows.map((row) => row.deviceId)).toEqual(["new", "old"]);
  });

  it("treats the upper bound as exclusive", async () => {
    await recordLoginLog(db, null, "today", NOW);

    // 半开区间：`fromMs === toMs` 是一段空区间。「查某一天」靠 `toMs` 取次日
    // 零点来实现，否则得纠结当天最后一秒。
    expect(await listLoginLogs(db, {fromMs: NOW, toMs: NOW}, 50)).toHaveLength(0);

    const oneDay = await listLoginLogs(
      db,
      {fromMs: NOW - DAY, toMs: NOW + DAY},
      50,
    );
    expect(oneDay.map((row) => row.deviceId)).toEqual(["today"]);
  });
});

describe("login log account columns", () => {
  it("keeps the account id even when the account carries no username", async () => {
    // 回归防护：显示方一度只看 userName，于是「只有邮箱、没有用户名」的账号整列
    // 被写成「未登录」——而真实库里大多数账号正是这种（auth_user 的 username 可空）。
    await seedUser("user-a");
    await db
      .prepare('UPDATE "auth_user" SET username = NULL WHERE id = ?')
      .bind("user-a")
      .run();
    await recordLoginLog(db, "user-a", "device-1", NOW);

    const row = only(await listLoginLogs(db, since(NOW, 1), 50));
    expect(row.userName).toBeNull();
    expect(row.userId).toBe("user-a");
    expect(row.userEmail).toBe("user-a@example.com");
  });

  it("does not borrow the device owner's name for a row that has its own account", async () => {
    // 回归防护（我自己的 bug）：设备回查挑的是该设备**最近活跃**的绑定账号，它未必是
    // 这一行记的那个账号。若把 du.* 和 lu.* 平起平坐地 COALESCE，那么「日志行有账号、
    // 但这个账号没设用户名」的行就会显示成「本行的 userId + 别人的 userName」。
    // 真实库里多数账号只有邮箱，这条路径必然被走到，且不会报错，只是默默串人。
    await seedUser("user-a");
    await seedUser("user-d");
    await db
      .prepare('UPDATE "auth_user" SET username = NULL WHERE id = ?')
      .bind("user-a")
      .run();
    await recordLoginLog(db, "user-a", "device-1", NOW);
    await bindDevice("user-d", "device-1", NOW);

    const row = only(await listLoginLogs(db, since(NOW, 1), 50));
    // user-d 有用户名；本行属于 user-a（没有用户名）。名字必须空着让 UI 退回 userId，
    // 绝不能变成 "user-d"。
    expect(row.userId).toBe("user-a");
    expect(row.userName).toBeNull();
    expect(row.userEmail).toBe("user-a@example.com");
  });

  it("fills the account in from the device binding when the row is anonymous", async () => {
    // App 没带凭证的那次启动时 user_id 为空；同一台设备之后登录过，设备表里
    // 就有绑定账号，这时不该让「谁的设备」空着。
    await seedUser("user-b");
    await recordLoginLog(db, null, "device-1", NOW);
    await bindDevice("user-b", "device-1", NOW);

    const row = only(await listLoginLogs(db, since(NOW, 1), 50));
    expect(row.userId).toBe("user-b");
    expect(row.userEmail).toBe("user-b@example.com");
  });

  it("does not split a row even when two accounts used the same device", async () => {
    await seedUser("user-b");
    await seedUser("user-c");
    await recordLoginLog(db, null, "device-1", NOW);
    await bindDevice("user-b", "device-1", NOW - DAY);
    await bindDevice("user-c", "device-1", NOW);

    // 设备表的主键是 (user_id, device_id)，同一台设备换过账号就是多行。
    // 直接 JOIN 会把一条日志翻成多条，行数变了整块看板就错了。
    const rows = await listLoginLogs(db, since(NOW, 1), 50);
    expect(rows).toHaveLength(1);
    // 取最近活跃的那个绑定账号。
    expect(rows[0]?.userId).toBe("user-c");
  });

  it("never overwrites the account the log row already has", async () => {
    await seedUser("user-b");
    await seedUser("user-c");
    await recordLoginLog(db, "user-b", "device-1", NOW);
    // 设备表指向另一个账号时，日志行自己的归属优先。
    await bindDevice("user-c", "device-1", NOW);

    const row = only(await listLoginLogs(db, since(NOW, 1), 50));
    expect(row.userId).toBe("user-b");
  });
});
