import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {DatabaseSync} from "node:sqlite";

import {describe, expect, it} from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

async function migration(name: string): Promise<string> {
  return readFile(path.join(repositoryRoot, "migrations", name), "utf8");
}

/**
 * 0133 的依赖链：0127 建表并种出节点，0128 加终端归属列，本文件再加入口两列。
 * `ext_menu` 只建 0133 读到的四列（回填规则 `node.code = 'page_' || menu.code`），
 * 不拖进整条菜单迁移链。
 */
describe("迁移 0133：页面节点的 path 与 entry_code", () => {
  async function fresh(): Promise<DatabaseSync> {
    const database = new DatabaseSync(":memory:");
    database.exec(await migration("0127_seed_permission_nodes.sql"));
    database.exec(await migration("0128_schema_permission_nodes_audience.sql"));
    database.exec(`
      CREATE TABLE ext_menu (
        code TEXT PRIMARY KEY,
        parent_code TEXT,
        path TEXT,
        permission_code TEXT
      );
      INSERT INTO ext_menu (code, parent_code, path, permission_code) VALUES
        ('group_account', NULL, '', ''),
        ('rbac', 'group_account', 'rbac', 'system:role:manage'),
        ('users', 'group_account', 'users', 'system:user:manage'),
        ('menu_management', 'group_account', 'menu', 'system:menu:manage'),
        ('rbac_audit', 'group_account', 'rbac/audit', 'system:role:manage'),
        ('group_review', NULL, '', ''),
        ('audit', 'group_review', 'audit', 'content:audit:read');
    `);
    database.exec(await migration("0133_schema_permission_nodes_entry.sql"));
    return database;
  }

  it("加两列，并沿 menu 行回填 path 与 entry_code", async () => {
    const database = await fresh();
    const columns = (
      database
        .prepare("PRAGMA table_info(ext_permission_nodes)")
        .all() as Array<{name: string}>
    ).map(({name}) => name);
    expect(columns).toContain("path");
    expect(columns).toContain("entry_code");

    const page = database.prepare(
      "SELECT path, entry_code FROM ext_permission_nodes WHERE code = ?",
    );
    expect(page.get("page_rbac")).toEqual({
      path: "rbac",
      entry_code: "system:role:manage",
    });
    expect(page.get("page_users")).toEqual({
      path: "users",
      entry_code: "system:user:manage",
    });
    expect(page.get("page_menu_management")).toEqual({
      path: "menu",
      entry_code: "system:menu:manage",
    });
    expect(page.get("page_audit")).toEqual({
      path: "audit",
      entry_code: "content:audit:read",
    });
    database.close();
  });

  it("没有菜单行的页面保持两列为空", async () => {
    const database = await fresh();
    const page = database.prepare(
      "SELECT path, entry_code FROM ext_permission_nodes WHERE code = ?",
    );
    expect(page.get("page_books")).toEqual({path: null, entry_code: null});
    database.close();
  });

  it("补出 rbac_audit 页面节点，与 page_rbac 共用门码", async () => {
    const database = await fresh();
    const row = database
      .prepare(
        "SELECT code, parent_code, sort, kind, audience, path, entry_code, " +
          "permission_code FROM ext_permission_nodes WHERE code = 'page_rbac_audit'",
      )
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      code: "page_rbac_audit",
      parent_code: "group_account",
      sort: 504,
      kind: "page",
      audience: "desktop",
      path: "rbac/audit",
      entry_code: "system:role:manage",
      permission_code: null,
    });
    database.close();
  });

  it("entry_code 非空但 path 为空时，插入与更新都被拦下", async () => {
    const database = await fresh();
    expect(() =>
      database.exec(`
        INSERT INTO ext_permission_nodes
          (id, code, kind, parent_code, sort, audience, permission_code, name_zh,
           name_en, icon, i18n_key, is_visible, source, created_at_ms, path, entry_code)
        VALUES
          ('pm_entry_no_path', 'page_entry_no_path', 'page', 'group_account', 900,
           'desktop', NULL, NULL, NULL, NULL, NULL, 1, 'custom', 1, NULL,
           'system:role:manage')
      `),
    ).toThrow(/entry_code requires path/);
    expect(() =>
      database.exec(
        "UPDATE ext_permission_nodes SET path = NULL WHERE code = 'page_rbac'",
      ),
    ).toThrow(/entry_code requires path/);
    database.close();
  });

  it("path 单独存在是允许的（只挂码、不进侧栏的页面）", async () => {
    const database = await fresh();
    database.exec("UPDATE ext_permission_nodes SET path = 'books' WHERE code = 'page_books'");
    expect(
      database
        .prepare("SELECT path, entry_code FROM ext_permission_nodes WHERE code = 'page_books'")
        .get(),
    ).toEqual({path: "books", entry_code: null});
    database.close();
  });
});
