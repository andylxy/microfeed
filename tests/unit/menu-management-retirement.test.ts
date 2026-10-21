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
 * 0135 的依赖链：0127 建节点表并种出节点，0128 加终端归属列，0133 补 path/entry_code，
 * 0135 删掉菜单管理页的节点、码、菜单行与授权。菜单/权限/映射/授权四张表只建
 * 0135 读到的列，不拖进整条历史迁移链。
 */
describe("迁移 0135：退役菜单管理页", () => {
  async function before(): Promise<DatabaseSync> {
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
      CREATE TABLE ext_menu_permissions (
        menu_code TEXT NOT NULL,
        permission_code TEXT NOT NULL
      );
      CREATE TABLE ext_permissions (
        id TEXT PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL
      );
      CREATE TABLE ext_role_permissions (
        role_id TEXT NOT NULL,
        permission_id TEXT NOT NULL
      );
      INSERT INTO ext_menu (code, parent_code, path, permission_code) VALUES
        ('group_account', NULL, '', ''),
        ('rbac', 'group_account', 'rbac', 'system:role:manage'),
        ('menu_management', 'group_account', 'menu', 'system:menu:manage');
      INSERT INTO ext_menu_permissions (menu_code, permission_code)
        VALUES ('menu_management', 'system:menu:manage');
      INSERT INTO ext_permissions (id, code, name)
        VALUES ('p_system_menu_manage', 'system:menu:manage', '菜单管理');
      INSERT INTO ext_role_permissions (role_id, permission_id)
        VALUES ('r_some_role', 'p_system_menu_manage');
    `);
    database.exec(await migration("0133_schema_permission_nodes_entry.sql"));
    return database;
  }

  function count(database: DatabaseSync, table: string, where: string): number {
    return (
      database.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`).get() as {
        c: number;
      }
    ).c;
  }

  it("removes the page node, its code node, the permission and the menu row", async () => {
    const database = await before();
    const nodeWhere = "code IN ('page_menu_management','system:menu:manage')";
    expect(count(database, "ext_permission_nodes", nodeWhere)).toBe(2);
    expect(count(database, "ext_permissions", "code = 'system:menu:manage'")).toBe(1);
    expect(count(database, "ext_menu", "code = 'menu_management'")).toBe(1);
    expect(count(database, "ext_menu_permissions", "menu_code = 'menu_management'")).toBe(1);
    expect(
      count(database, "ext_role_permissions", "permission_id = 'p_system_menu_manage'"),
    ).toBe(1);

    database.exec(await migration("0135_cleanup_retire_menu_management.sql"));

    expect(count(database, "ext_permission_nodes", nodeWhere)).toBe(0);
    expect(count(database, "ext_permissions", "code = 'system:menu:manage'")).toBe(0);
    expect(count(database, "ext_menu", "code = 'menu_management'")).toBe(0);
    expect(count(database, "ext_menu_permissions", "menu_code = 'menu_management'")).toBe(0);
    expect(
      count(database, "ext_role_permissions", "permission_id = 'p_system_menu_manage'"),
    ).toBe(0);
    database.close();
  });

  it("drops exactly two rows from the desktop tree", async () => {
    const database = await before();
    const desktop = () =>
      count(database, "ext_permission_nodes", "audience = 'desktop'");
    const beforeCount = desktop();
    database.exec(await migration("0135_cleanup_retire_menu_management.sql"));
    expect(beforeCount - desktop()).toBe(2);
    database.close();
  });
});
