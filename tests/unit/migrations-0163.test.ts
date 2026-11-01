/**
 * 0163 的两条语句：清空 `auth_user.role`，收拢 `signup_source` 的越界值。
 *
 * 静态部分守语句形态（两条都只碰 `auth_user`，不回头改 `ext_user_roles`）；
 * 行为部分在内存库里跑一遍，确认「清空」不是「改成别的值」、越界值确实被收回。
 * 后者才是这条迁移的目的，前者只防有人编辑时把语句改歪。
 */
import {readFile} from "node:fs/promises";
import {DatabaseSync} from "node:sqlite";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

async function migration0163(): Promise<string> {
  return readFile(
    path.join(
      repositoryRoot,
      "migrations",
      "0163_data_clear_auth_user_role.sql",
    ),
    "utf8",
  );
}

/** 去掉注释行：`-- rollback:` 段里的示例语句会干扰匹配。 */
function bodyOf(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

describe("0163 的语句形态", () => {
  it("带 rollback 段，两条语句都只改 auth_user", async () => {
    const source = await migration0163();
    expect(source).toContain("-- rollback:");
    expect(source).toContain("type = data");

    const body = bodyOf(source);
    expect(body.match(/UPDATE\s+"auth_user"/gu) ?? []).toHaveLength(2);
    // 镜像已废止，回填方向反过来（从授权行推 role）只出现在 rollback 说明里，
    // 正向语句不得再碰 ext_user_roles。
    expect(body).not.toMatch(/ext_user_roles/u);
  });

  it("role 那条按 IS NOT NULL，不写成常量比较", async () => {
    const body = bodyOf(await migration0163());
    expect(body).toMatch(
      /UPDATE\s+"auth_user"\s+SET\s+"role"\s*=\s*NULL\s+WHERE\s+"role"\s+IS\s+NOT\s+NULL/u,
    );
    // 曾有两个取值 'admin' / 'user'，按值删会漏掉以后混进来的第三种。
    expect(body).not.toMatch(/"role"\s*=\s*'admin'/u);
    expect(body).not.toMatch(/"role"\s*=\s*'user'/u);
  });

  it("signup_source 那条按三值反向枚举", async () => {
    const body = bodyOf(await migration0163());
    expect(body).toMatch(
      /"signup_source"\s+NOT\s+IN\s*\(\s*'email'\s*,\s*'qq'\s*,\s*'admin'\s*\)/u,
    );
    // 0157 是 TEXT NOT NULL DEFAULT 'email'，NULL 在存储层写不进去，
    // `IS NULL` 是永不命中的空语句。
    expect(body).not.toMatch(/"signup_source"\s+IS\s+NULL/u);
  });
});

/** 只保留两条语句涉及的列；`email_usable` 是生成列，这里不复制。 */
const AUTH_USER_SCHEMA = `
CREATE TABLE "auth_user" (
  "id" TEXT PRIMARY KEY,
  "email" TEXT NOT NULL UNIQUE,
  "role" TEXT,
  "signup_source" TEXT NOT NULL DEFAULT 'email'
);
CREATE TABLE "ext_roles" (
  "id" TEXT PRIMARY KEY,
  "code" TEXT NOT NULL UNIQUE
);
CREATE TABLE "ext_user_roles" (
  "user_id" TEXT NOT NULL,
  "role_id" TEXT NOT NULL,
  PRIMARY KEY ("user_id", "role_id")
);
`;

describe("0163 在真实库上的效果", () => {
  it("role 一律清空，授权行原样保留", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(AUTH_USER_SCHEMA);
    database.exec(
      'INSERT INTO "ext_roles" ("id", "code") VALUES ' +
        "('r_admin', 'super_admin'), ('r_user', 'editor')",
    );

    const insert = database.prepare(
      'INSERT INTO "auth_user" ("id", "email", "role", "signup_source") ' +
        "VALUES (?, ?, ?, ?)",
    );
    insert.run("u1", "a@example.com", "admin", "admin");
    insert.run("u2", "b@example.com", "user", "email");
    insert.run("u3", "c@example.com", null, "qq");

    const grant = database.prepare(
      'INSERT INTO "ext_user_roles" ("user_id", "role_id") VALUES (?, ?)',
    );
    grant.run("u1", "r_admin");
    grant.run("u2", "r_user");

    database.exec(await migration0163());

    expect(
      database.prepare('SELECT "role" FROM "auth_user" ORDER BY "id"').all(),
    ).toEqual([{role: null}, {role: null}, {role: null}]);
    // 授权是判定依据，清镜像不能顺手动它。
    expect(
      database
        .prepare('SELECT "user_id", "role_id" FROM "ext_user_roles" ORDER BY "user_id"')
        .all(),
    ).toEqual([
      {role_id: "r_admin", user_id: "u1"},
      {role_id: "r_user", user_id: "u2"},
    ]);
  });

  it("越界 signup_source 收敛回 email，合法三种不动", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(AUTH_USER_SCHEMA);
    const insert = database.prepare(
      'INSERT INTO "auth_user" ("id", "email", "role", "signup_source") ' +
        "VALUES (?, ?, NULL, ?)",
    );
    insert.run("u1", "a@example.com", "email");
    insert.run("u2", "b@example.com", "qq");
    insert.run("u3", "c@example.com", "admin");
    insert.run("u4", "d@example.com", "wechat");
    insert.run("u5", "e@example.com", "");

    database.exec(await migration0163());

    expect(
      database
        .prepare('SELECT "id", "signup_source" FROM "auth_user" ORDER BY "id"')
        .all(),
    ).toEqual([
      {id: "u1", signup_source: "email"},
      {id: "u2", signup_source: "qq"},
      {id: "u3", signup_source: "admin"},
      {id: "u4", signup_source: "email"},
      {id: "u5", signup_source: "email"},
    ]);
  });

  it("重放不产生新的改动", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(AUTH_USER_SCHEMA);
    database.exec(
      'INSERT INTO "auth_user" ("id", "email", "role", "signup_source") ' +
        "VALUES ('u1', 'a@example.com', 'admin', 'wechat')",
    );
    const source = await migration0163();
    database.exec(source);
    const before = database
      .prepare('SELECT "id", "role", "signup_source" FROM "auth_user"')
      .all();
    expect(before).toEqual([{id: "u1", role: null, signup_source: "email"}]);

    database.exec(source);
    expect(
      database.prepare('SELECT "id", "role", "signup_source" FROM "auth_user"').all(),
    ).toEqual(before);
  });
});
