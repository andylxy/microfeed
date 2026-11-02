/**
 * 0164 只有一句话：DROP 掉零读零写的 ext_menu_permissions。
 *
 * 静态部分守语句形态与 rollback 说明；行为部分在内存库里建表、跑迁移，
 * 确认表与索引真的消失、重放不报错（IF EXISTS 的意义）。
 */
import {readFile} from "node:fs/promises";
import {DatabaseSync} from "node:sqlite";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

async function migration0164(): Promise<string> {
  return readFile(
    path.join(
      repositoryRoot,
      "migrations",
      "0164_schema_drop_ext_menu_permissions.sql",
    ),
    "utf8",
  );
}

/** 去掉注释行：rollback 段里的重建 DDL 会干扰匹配。 */
function bodyOf(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

describe("0164 的语句形态", () => {
  it("带 rollback 段，正文只有一句 DROP TABLE IF EXISTS", async () => {
    const source = await migration0164();
    expect(source).toContain("-- rollback:");
    expect(source).toContain("type = schema");

    const body = bodyOf(source);
    const statements = body
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(statements).toEqual(["DROP TABLE IF EXISTS ext_menu_permissions"]);
    // 一迁移一对象：不许顺手碰菜单表本身（ext_menu_permissions 里的
    // ext_menu 前缀不带词边界，\bext_menu\b 只命中独立出现的菜单表名）。
    expect(body).not.toMatch(/\bext_menu\b/u);
  });
});

/** 0052 的现行结构，rollback 说明引用的同款 DDL。 */
const MENU_PERMISSIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS ext_menu_permissions (
  menu_code       TEXT NOT NULL,
  permission_code TEXT NOT NULL,
  PRIMARY KEY (menu_code, permission_code)
);
CREATE INDEX IF NOT EXISTS ix_ext_menu_permissions_permission
  ON ext_menu_permissions(permission_code);
`;

describe("0164 在真实库上的效果", () => {
  it("表与索引一起消失，重放不报错", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(MENU_PERMISSIONS_SCHEMA);
    database.exec(
      "INSERT INTO ext_menu_permissions (menu_code, permission_code) " +
        "VALUES ('books', 'content:book:read')",
    );

    database.exec(await migration0164());

    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master " +
            "WHERE type IN ('table', 'index') AND name LIKE '%menu_permissions'",
        )
        .all(),
    ).toEqual([]);

    // IF EXISTS 的意义：wrangler 重放或误跑两次都不炸。
    database.exec(await migration0164());
  });
});
