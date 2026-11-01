import {readdir, readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";

import {
  USER_DELETE_EXEMPT,
  USER_OWNED_TABLES,
} from "@/server/admin/user-owned-tables";

/**
 * 删号清单的覆盖闸门。
 *
 * 漏一张从属表就留下孤儿行；`NO ACTION` 外键的两张表更严重——同名 id 重建后会
 * 继承旧的密钥归属与权限。判据从迁移文件里推：凡是建表语句里带 `user_id` /
 * `userId` 列的表，都必须出现在 `USER_OWNED_TABLES` 或 `USER_DELETE_EXEMPT` 里。
 *
 * 只解析 DDL、不执行迁移：148 个迁移里有 FTS 虚拟表与触发器，进程内跑一遍既慢
 * 又会因引擎差异失败。列清单的完整性只取决于建表语句，与数据无关。
 *
 * `DROP TABLE` 与 `ALTER TABLE … RENAME TO` 按出现顺序一起处理：0038 重建了
 * `ext_api_access_log`（建 `_v2`、删旧表、改名），只看建表语句会多算出一张
 * 已经不存在的表。
 */
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const migrationsDirectory = path.join(repositoryRoot, "migrations");
const USER_COLUMNS = new Set(["user_id", "userId"]);

const CREATE_TABLE =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z_][\w]*)"?\s*\(/giu;
const DROP_TABLE =
  /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z_][\w]*)"?/giu;
const RENAME_TABLE =
  /ALTER\s+TABLE\s+"?([A-Za-z_][\w]*)"?\s+RENAME\s+TO\s+"?([A-Za-z_][\w]*)"?/giu;

const CONSTRAINT_PREFIX = /^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)\b/iu;

/** 去掉整行的 `--` 注释：注释里的示例 DDL 与 rollback 段会干扰解析。 */
function stripLineComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

/** 从 `(` 之后按括号配对截出整段列定义。 */
function balancedBody(source: string, openIndex: number): string {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openIndex + 1, index);
      }
    }
  }
  throw new Error("建表语句的括号没有闭合");
}

/** 按顶层逗号切开列定义，嵌套括号（如 `CHECK (x IN (...))`）不参与切分。 */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of body) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

function columnNames(body: string): string[] {
  return splitTopLevel(body)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !CONSTRAINT_PREFIX.test(part))
    .map((part) => part.match(/^"?([A-Za-z_][\w]*)"?/u)?.[1] ?? "")
    .filter((name) => name.length > 0);
}

/** 表名 → 列名，按迁移顺序演进。 */
async function tablesFromMigrations(): Promise<Map<string, Set<string>>> {
  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));
  const tables = new Map<string, Set<string>>();
  for (const filename of filenames) {
    const source = stripLineComments(
      await readFile(path.join(migrationsDirectory, filename), "utf8"),
    );
    const events: {index: number; apply: () => void}[] = [];
    for (const match of source.matchAll(CREATE_TABLE)) {
      const table = match[1] ?? "";
      const openIndex = (match.index ?? 0) + match[0].length - 1;
      events.push({
        index: match.index ?? 0,
        apply: () => {
          const columns = tables.get(table) ?? new Set<string>();
          for (const column of columnNames(balancedBody(source, openIndex))) {
            columns.add(column);
          }
          tables.set(table, columns);
        },
      });
    }
    for (const match of source.matchAll(DROP_TABLE)) {
      const table = match[1] ?? "";
      events.push({
        index: match.index ?? 0,
        apply: () => {
          tables.delete(table);
        },
      });
    }
    for (const match of source.matchAll(RENAME_TABLE)) {
      const from = match[1] ?? "";
      const to = match[2] ?? "";
      events.push({
        index: match.index ?? 0,
        apply: () => {
          const columns = tables.get(from);
          if (columns) {
            tables.set(to, new Set(columns));
            tables.delete(from);
          }
        },
      });
    }
    events.sort((left, right) => left.index - right.index);
    for (const event of events) event.apply();
  }
  return tables;
}

const ownedTables = new Set<string>(USER_OWNED_TABLES.map((entry) => entry.table));
const exemptTables = new Set<string>(USER_DELETE_EXEMPT);

describe("删号清单覆盖所有按 userId 引用的表", () => {
  it("迁移里每一张带 user_id / userId 的表都在清单内或被明确豁免", async () => {
    const tables = await tablesFromMigrations();
    const userScoped = [...tables.entries()]
      .filter(([, columns]) =>
        [...USER_COLUMNS].some((column) => columns.has(column))
      )
      .map(([table]) => table)
      .sort();

    const uncovered = userScoped.filter((table) =>
      !ownedTables.has(table) && !exemptTables.has(table)
    );
    expect(uncovered).toEqual([]);
    // 18 张：17 张随账号删，`ext_api_access_log` 豁免。新增从属表时这个数字会变，
    // 逼人回头确认清单，而不是默默漏掉。
    expect(userScoped).toHaveLength(18);
  });

  it("清单里的表都真实存在，列名与建表语句一致", async () => {
    const tables = await tablesFromMigrations();
    for (const entry of USER_OWNED_TABLES) {
      expect(tables.has(entry.table)).toBe(true);
      expect(tables.get(entry.table)?.has(entry.column)).toBe(true);
    }
    for (const table of USER_DELETE_EXEMPT) {
      expect(tables.has(table)).toBe(true);
    }
  });

  it("豁免表与删除表不重叠，且 auth_user 本身不在清单里", () => {
    for (const table of exemptTables) {
      expect(ownedTables.has(table)).toBe(false);
    }
    // `auth_user` 由删号 handler 单独收尾，不在从属清单内。
    expect(ownedTables.has("auth_user")).toBe(false);
  });
});
