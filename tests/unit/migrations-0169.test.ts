/**
 * 0169 的两件事：把库里出现但配置里没有的来源登记进 `signup_sources`、
 * 给「没有任何角色」的账号补 `r_readonly`。
 *
 * 0081 之后这里改过一次口径：**不抹数据**。手工写入的越界值（本机实测 `back`）
 * 会被登记成正式分组，而不是收敛回 `email`——收敛的对象是「配置与数据的取值域
 * 不一致」，不是数据本身。
 *
 * 顺序也被测了：`UNION` 会让 SQLite 按值排序，把管理员排好的分组顺序打乱，
 * 所以合并语句用「数组下标占位 + 追加到末尾」。
 */
import {readFile} from "node:fs/promises";
import {DatabaseSync} from "node:sqlite";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

async function migration0169(): Promise<string> {
  return readFile(
    path.join(
      repositoryRoot,
      "migrations",
      "0169_data_signup_source_register_and_default_role.sql",
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

const SCHEMA = `
CREATE TABLE "settings" (
  "category" TEXT PRIMARY KEY,
  "data" TEXT,
  "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "auth_user" (
  "id" TEXT PRIMARY KEY,
  "signup_source" TEXT NOT NULL DEFAULT 'email'
);
CREATE TABLE "ext_roles" (
  "id" TEXT PRIMARY KEY,
  "code" TEXT NOT NULL UNIQUE,
  "is_member" INTEGER,
  "allow_admin_login" INTEGER
);
CREATE TABLE "ext_permissions" ("id" TEXT PRIMARY KEY, "code" TEXT NOT NULL UNIQUE);
CREATE TABLE "ext_role_permissions" (
  "role_id" TEXT NOT NULL,
  "permission_id" TEXT NOT NULL,
  PRIMARY KEY ("role_id", "permission_id")
);
CREATE TABLE "ext_user_roles" (
  "user_id" TEXT NOT NULL,
  "role_id" TEXT NOT NULL,
  PRIMARY KEY ("user_id", "role_id")
);
CREATE TABLE "ext_user_permissions" (
  "user_id" TEXT PRIMARY KEY,
  "codes" TEXT,
  "is_member" INTEGER,
  "admin_login_allowed" INTEGER,
  "updated_at" TIMESTAMP
);
`;

function freshDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(SCHEMA);
  database.exec(
    "INSERT INTO \"ext_roles\" VALUES ('r_readonly', 'readonly', 0, 1)",
  );
  database.exec("INSERT INTO \"ext_permissions\" VALUES ('p1', 'content:book:read')");
  database.exec("INSERT INTO \"ext_role_permissions\" VALUES ('r_readonly', 'p1')");
  return database;
}

function storedSources(database: DatabaseSync): {label: string; value: string}[] {
  const row = database
    .prepare("SELECT data FROM settings WHERE category = 'signup_sources'")
    .get() as {data: string} | undefined;
  return row ? (JSON.parse(row.data) as {label: string; value: string}[]) : [];
}

describe("0169 的语句形态", () => {
  it("带 rollback 段，声明 type = data", async () => {
    const source = await migration0169();
    expect(source).toContain("-- rollback:");
    expect(source).toContain("type = data");
  });

  it("不直接改写 auth_user.signup_source —— 手工值由登记成组来收敛", async () => {
    const body = bodyOf(await migration0169());
    expect(body).not.toMatch(/UPDATE\s+"auth_user"[\s\S]*"signup_source"/iu);
    // 登记靠 settings 的 JSON 合并，坏配置要跳过（留给读路径补全）。
    expect(body).toContain("json_valid");
    expect(body).toContain("json_type");
  });

  it("只读回填补的是「无任何角色」，不是「无 readonly」", async () => {
    const body = bodyOf(await migration0169());
    expect(body).toMatch(/NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+"ext_user_roles"/iu);
    expect(body).not.toMatch(/role_id"\s*<>\s*'r_readonly'/u);
  });
});

describe("0169 在真实库上的效果", () => {
  it("配置行不存在时建一份：与 DEFAULT 同序，库里的其它值追加在后", async () => {
    const database = freshDatabase();
    const insert = database.prepare('INSERT INTO "auth_user" VALUES (?, ?)');
    insert.run("a", "admin");
    insert.run("b", "partner");
    insert.run("c", "partner");
    insert.run("d", "email");

    database.exec(await migration0169());

    // 前三/四项与 `DEFAULT_SIGNUP_SOURCES` 必须同一份：配置行一旦建出来，
    // 读路径就不再用代码默认值，两边不一致会让某个分组凭空消失。
    expect(storedSources(database).map((entry) => entry.value))
      .toEqual(["admin", "email", "qq", "back", "partner"]);
    expect(storedSources(database).at(-1)).toEqual({label: "partner", value: "partner"});
  });

  it("库里没有账号时也建出同样的默认四档", async () => {
    const database = freshDatabase();
    database.exec(await migration0169());
    expect(storedSources(database)).toEqual([
      {label: "管理员", value: "admin"},
      {label: "邮箱注册", value: "email"},
      {label: "QQ 登录", value: "qq"},
      {label: "后台创建", value: "back"},
    ]);
  });

  it("配置行已存在时追加缺失值，并保住管理员排好的顺序与改过的显示名", async () => {
    const database = freshDatabase();
    database
      .prepare("INSERT INTO settings (category, data) VALUES ('signup_sources', ?)")
      .run(JSON.stringify([
        {label: "运维建的", value: "admin"},
        {label: "邮箱注册", value: "email"},
        {label: "QQ 登录", value: "qq"},
      ]));
    const insert = database.prepare('INSERT INTO "auth_user" VALUES (?, ?)');
    insert.run("a", "back");
    insert.run("b", "email");

    database.exec(await migration0169());

    expect(storedSources(database)).toEqual([
      {label: "运维建的", value: "admin"},
      {label: "邮箱注册", value: "email"},
      {label: "QQ 登录", value: "qq"},
      {label: "back", value: "back"},
    ]);
  });

  it("重放幂等：配置与授权都不再变化", async () => {
    const database = freshDatabase();
    database.prepare('INSERT INTO "auth_user" VALUES (?, ?)').run("a", "back");

    const body = await migration0169();
    database.exec(body);
    const sources = JSON.stringify(storedSources(database));
    const roles = database
      .prepare('SELECT "user_id", "role_id" FROM "ext_user_roles" ORDER BY "user_id"')
      .all();
    database.exec(body);

    expect(JSON.stringify(storedSources(database))).toBe(sources);
    expect(
      database
        .prepare('SELECT "user_id", "role_id" FROM "ext_user_roles" ORDER BY "user_id"')
        .all(),
    ).toEqual(roles);
  });

  it("坏配置不覆盖——那种情况留给读路径补全", async () => {
    const database = freshDatabase();
    database
      .prepare("INSERT INTO settings (category, data) VALUES ('signup_sources', '{not json')")
      .run();
    database.prepare('INSERT INTO "auth_user" VALUES (?, ?)').run("a", "back");

    database.exec(await migration0169());

    const row = database
      .prepare("SELECT data FROM settings WHERE category = 'signup_sources'")
      .get() as {data: string};
    expect(row.data).toBe("{not json");
  });

  it("无角色的账号补上 r_readonly，已有角色的账号一条不多", async () => {
    const database = freshDatabase();
    database.exec("INSERT INTO \"ext_roles\" VALUES ('r_editor', 'editor')");
    const insert = database.prepare('INSERT INTO "auth_user" VALUES (?, ?)');
    insert.run("u-orphan", "qq");
    insert.run("u-editor", "email");
    const grant = database.prepare(
      'INSERT INTO "ext_user_roles" ("user_id", "role_id") VALUES (?, ?)',
    );
    grant.run("u-editor", "r_editor");

    database.exec(await migration0169());

    expect(
      database
        .prepare('SELECT "user_id", "role_id" FROM "ext_user_roles" ORDER BY "user_id"')
        .all(),
    ).toEqual([
      {role_id: "r_readonly", user_id: "u-orphan"},
      {role_id: "r_editor", user_id: "u-editor"},
    ]);
  });
});
