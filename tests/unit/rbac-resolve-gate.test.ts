import {DatabaseSync} from "node:sqlite";

import {describe, expect, it} from "vitest";

import {resolveRbacContext} from "@/server/rbac/resolve";
import {makeD1, makeSqlite} from "./server/helpers/d1";

/**
 * 后台鉴权的取数形态守卫。
 *
 * 权限码、会员标记、后台准入、封禁位、待改密五项原先分散在 3 条语句里，现在
 * 都由权限快照的一条点查 LEFT JOIN 出来（ADR-0053）。这里在真实 SQLite 上跑
 * 那条查询（AGENTS.md 禁止 mock），顺带数 `prepare()` 的次数钉住「只有一条」。
 */

const SCHEMA = `
CREATE TABLE auth_user (
  id TEXT PRIMARY KEY,
  banned INTEGER
);
CREATE TABLE ext_user_security (
  user_id TEXT PRIMARY KEY,
  must_change_password INTEGER
);
CREATE TABLE ext_user_permissions (
  user_id TEXT PRIMARY KEY,
  codes TEXT NOT NULL,
  is_member INTEGER NOT NULL DEFAULT 0,
  admin_login_allowed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
`;

const request = new Request("https://feed.example.com/admin");

/** 记下每条 `prepare()` 的 SQL，再交给真实 D1 适配层执行。 */
function countingDb(database: DatabaseSync): {
  db: D1Database;
  statements: string[];
} {
  const statements: string[] = [];
  const inner = makeD1(database);
  const db = {
    prepare(sql: string) {
      statements.push(sql);
      return inner.prepare(sql);
    },
    batch: (list: D1PreparedStatement[]) => inner.batch(list),
  };
  return {db: db as unknown as D1Database, statements};
}

interface Fixture {
  banned?: number;
  codes?: string;
  isMember?: number;
  mustChange?: number;
  /** 有角色分配时才写快照行；填 false 表示零角色账号。 */
  snapshot?: boolean;
  /** 填 false 表示 auth_user 里没有这个账号。 */
  user?: boolean;
}

function fixture(userId: string, options: Fixture = {}): DatabaseSync {
  const {
    banned = 0,
    codes = '["content:book:read","*"]',
    isMember = 0,
    mustChange = 0,
    snapshot = true,
    user = true,
  } = options;
  const database = makeSqlite(SCHEMA);
  if (user) {
    database.prepare("INSERT INTO auth_user (id, banned) VALUES (?, ?)")
      .run(userId, banned);
    database
      .prepare(
        "INSERT INTO ext_user_security (user_id, must_change_password) VALUES (?, ?)",
      )
      .run(userId, mustChange);
  }
  if (user && snapshot) {
    database
      .prepare(
        `INSERT INTO ext_user_permissions
           (user_id, codes, is_member, admin_login_allowed, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      )
      .run(userId, codes, isMember, 1);
  }
  return database;
}

describe("resolveRbacContext 的权限快照", () => {
  it("一条点查取回全部五项", async () => {
    const {db, statements} = countingDb(fixture("u1"));
    const resolved = await resolveRbacContext(db, "u1", request);
    expect(statements).toHaveLength(1);

    // 快照、封禁、待改密必须一次点查：任何一项改回独立语句都会在这里报。
    const sql = statements[0]!;
    expect(sql).toMatch(/FROM\s+auth_user\s+u/u);
    expect(sql).toMatch(/LEFT\s+JOIN\s+ext_user_security/u);
    expect(sql).toMatch(/LEFT\s+JOIN\s+ext_user_permissions/u);
    expect(sql).toContain("COALESCE(sec.must_change_password, 0)");

    expect([...resolved.permissions].sort()).toEqual(["*", "content:book:read"]);
    expect(resolved.adminLoginAllowed).toBe(true);
    expect(resolved.banned).toBe(false);
  });

  it("codes 解析成 Set，可以直接用 has 判定", async () => {
    const {db} = countingDb(fixture("u-set"));
    const resolved = await resolveRbacContext(db, "u-set", request);
    // `permissionsInclude` 用 `.has()` 判定，数组会让它静默失效。
    expect(resolved.permissions).toBeInstanceOf(Set);
    expect(resolved.permissions.has("content:book:read")).toBe(true);
  });

  it("安全表没有该账号的行时视为不需要改密", async () => {
    const database = fixture("u-secure");
    database.prepare("DELETE FROM ext_user_security").run();
    const {db} = countingDb(database);
    const resolved = await resolveRbacContext(db, "u-secure", request);
    expect(resolved.banned).toBe(false);
    expect(resolved.mustChangePassword).toBe(false);
  });

  it("封禁与待改密同时为真时两个标记都为真", async () => {
    const {db} = countingDb(fixture("u-banned", {banned: 1, mustChange: 1}));
    const resolved = await resolveRbacContext(db, "u-banned", request);
    expect(resolved.banned).toBe(true);
    expect(resolved.mustChangePassword).toBe(true);
  });

  it("账号行缺失时按封禁处理，且不要求改密", async () => {
    const {db} = countingDb(fixture("u-missing", {user: false}));
    const resolved = await resolveRbacContext(db, "u-missing", request);
    expect(resolved.banned).toBe(true);
    expect(resolved.mustChangePassword).toBe(false);
    expect(resolved.adminLoginAllowed).toBe(false);
  });

  it("快照行缺失时权限为空且拒绝进入后台", async () => {
    // 零角色账号：auth_user 有行，ext_user_permissions 没有对应行。
    const {db} = countingDb(fixture("u-no-role", {snapshot: false}));
    const resolved = await resolveRbacContext(db, "u-no-role", request);
    expect(resolved.permissions.size).toBe(0);
    expect(resolved.adminLoginAllowed).toBe(false);
    // 账号本身存在，所以不算被封禁。
    expect(resolved.banned).toBe(false);
  });

  it("codes 的值不是 JSON 数组时直接抛出", async () => {
    // fast-fail（AGENTS.md）：坏值说明写入不变量已被破坏，就地报错，不做降级。
    // 两种坏法都要抛：语法坏（JSON.parse 自己抛）与形状坏（本模块抛）。
    const broken = countingDb(fixture("u-bad", {codes: "not-json"}));
    await expect(resolveRbacContext(broken.db, "u-bad", request)).rejects.toThrow();

    const wrongShape = countingDb(fixture("u-shape", {codes: '{"a":1}'}));
    await expect(
      resolveRbacContext(wrongShape.db, "u-shape", request),
    ).rejects.toThrow(TypeError);
  });
});
