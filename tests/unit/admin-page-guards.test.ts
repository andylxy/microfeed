import {readdirSync, readFileSync} from "node:fs";
import {join, relative} from "node:path";

import {describe, expect, it} from "vitest";

import {migrationNames, readMigration} from "./support/migrations";
import {PERMISSION_CODES} from "../../src/shared/Constants";
import {ADMIN_PAGE_GUARDS} from "../../src/shared/AdminPageGuards";

/**
 * 菜单设计的那条一致性红线：一个菜单入口绑一个权限码，它指向的页面必须用
 * **同一个码**守卫。两个方向漂移都是别的测试抓不到的坏体验——菜单会显示一个
 * 点进去 403 的链接，或者把一个本可打开的页面藏起来。
 *
 * 条目来自权限树：侧栏读的是 `ext_permission_nodes`（0133，ADR-0042 D6），页面
 * 节点带着旧 `ext_menu` 行里那些 `path` / `parent_code` / `entry_code`。菜单行本身
 * 已由 `0168` 删除（ADR-0057），所以这里重放的是**节点**种子——`INSERT INTO
 * ext_permission_nodes`、那些改父级与改名的 `UPDATE`、以及 `DELETE`——按迁移顺序
 * 依次应用，而不是去读第二份列表或单个文件（那会过期）。
 *
 * 重放 `UPDATE` 与 `DELETE` 是必要的：多数 `parent_code` 由 `UPDATE` 设置
 * （0129 重排 App 树、0135 删掉退役的菜单页），只读 `INSERT` 会让行缺父级，
 * 然后被「挂在分组下」那条检查静默跳过。
 */

const PAGES = join("src", "pages", "[adminPath]");

/** 桌面权限树里的一个页面节点——侧栏渲染成链接的那一行。 */
interface PageNode {
  code: string;
  parentCode: string | null;
  path: string;
  entryCode: string | null;
  /** `desktop` (the admin sidebar) or `app` (the App tab bar). */
  audience: string;
}

/** `NULL` (or an empty literal) stays null; a quoted literal loses its quotes. */
function nullableLiteral(raw: string | undefined): string | null {
  if (!raw || raw === "NULL" || raw === "''") return null;
  return raw.slice(1, -1);
}

/**
 * 把一个 `SET` 子句按**真正的**分隔逗号切成若干赋值——引号内的逗号不算，
 * 直接 `split(",")` 会在那里切错。
 */
/** Drop the surrounding quotes of a leading string literal, if it is one. */
function leadingLiteral(raw: string): string {
  const text = raw.trim();
  if (!text.startsWith("'")) return text;
  let value = "";
  for (let index = 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === "'") {
      if (text[index + 1] === "'") {
        value += "'";
        index += 1;
        continue;
      }
      break;
    }
    value += character;
  }
  return value;
}

/**
 * 把逗号分隔的子句按真正的分隔逗号切成若干段。
 *
 * 只看引号不够：节点种子每个 `VALUES` 元组都以
 * `CAST(strftime('%s', 'now') AS INTEGER) * 1000` 结尾，那个调用里的逗号夹在
 * 两个字符串字面量之间，只靠引号状态计数会把时间戳表达式切成两半。于是每个
 * 元组都多出一段、被列数检查丢掉，最终重放出一棵空树。这里同时跟踪括号深度；
 * 连写的 `''` 是转义引号，不是闭合引号。
 */
function splitAssignments(clause: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (let index = 0; index < clause.length; index += 1) {
    const character = clause[index];
    if (quoted) {
      current += character;
      if (character === "'") {
        if (clause[index + 1] === "'") {
          current += clause[index + 1];
          index += 1;
        } else {
          quoted = false;
        }
      }
      continue;
    }
    if (character === "'") {
      quoted = true;
      current += character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

/**
 * 把一条 `UPDATE ext_permission_nodes` 的 `SET …` 子句应用到一行上。
 *
 * 只跟踪本测试要读的列；`sort`、`icon`、`is_visible` 与显示名刻意不跟。值是
 * 裸数字的赋值（如 `sort = 601`）会被跳过，所以取值模式写成 `NULL|'…'`。
 */
function applyNodeAssignments(row: PageNode, assignments: string): void {
  for (const assignment of splitAssignments(assignments)) {
    const parsed = /^\s*(?<column>[a-z_]+)\s*=\s*(?<value>NULL|'[^']*')\s*$/iu
      .exec(assignment);
    const column = parsed?.groups?.column;
    if (!column) continue;
    const value = nullableLiteral(parsed?.groups?.value);
    if (column === "parent_code") row.parentCode = value;
    else if (column === "entry_code") row.entryCode = value;
    else if (column === "path") row.path = value ?? "";
    // 0129 在同一条语句里把三个纯 App 节点改挂到 `group_app` 并改 `audience`；
    // 不跟这一列，App 树会漏进桌面端集合，`group_app` 会被当成侧栏分组。
    else if (column === "audience" && value) row.audience = value;
  }
}

/**
 * 应用一条 `UPDATE ext_permission_nodes SET … WHERE …`。
 *
 * 迁移里出现过三种谓词形态，都建模了：按 `code` 指定单行、一串 `code`
 * （`WHERE code IN ('a', 'b')`，0129 用它把三个 App 码改成 `desktop`）、以及
 * 不带这两个条件的 `kind = 'page'` 全扫——0133 的那次回填，它靠对联表当时还
 * 存在的 `ext_menu` 的相关子查询写 `path` 与 `entry_code`，也正是「0168 删除那张
 * 表之前，树里已经有菜单路径」的原因。该语句在子查询里还带第三个 `WHERE`，所以
 * 形态判定要在谓词里**任意位置**匹配，不能锚定开头。
 *
 * 三种之外的形态一律抛错而不是跳过：忽略一条 `UPDATE` 正是这个解析器开始拿
 * 过期树去校验页面的起点。
 */
function applyNodeUpdate(
  rows: Map<string, PageNode>,
  assignments: string,
  predicate: string,
  menu: Map<string, {path: string; entryCode: string | null}>,
): void {
  const byCode = /^code\s*=\s*'([^']+)'/iu.exec(predicate);
  if (byCode) {
    const row = rows.get(byCode[1] ?? "");
    if (row) applyNodeAssignments(row, assignments);
    return;
  }
  const codeList = /^code\s+IN\s*\(([^)]*)\)$/iu.exec(predicate);
  if (codeList) {
    for (const literal of (codeList[1] ?? "").matchAll(/'([^']+)'/gu)) {
      const row = rows.get(literal[1] ?? "");
      if (row) applyNodeAssignments(row, assignments);
    }
    return;
  }
  if (/\bkind\s*=\s*'page'/u.test(predicate)) {
    // 0133's backfill: `path` and `entry_code` are correlated subqueries over
    // `ext_menu`, joined by `code = 'page_' || m.code` and filtered to rows with
    // a parent. Replaying it off a name convention would be wrong — the values
    // come from the menu rows, and `books` binds `content:book:read`, not the
    // page's own name. Rows absent from the menu (e.g. `page_media`) stay empty,
    // which is exactly what the EXISTS clause does.
    for (const row of rows.values()) {
      if (!row.code.startsWith("page_")) continue;
      const entry = menu.get(row.code.slice("page_".length));
      if (!entry) continue;
      row.path = entry.path;
      row.entryCode = entry.entryCode;
    }
    return;
  }
  throw new Error(
    `unhandled ext_permission_nodes UPDATE: SET ${assignments} WHERE ${predicate}`,
  );
}

/**
 * 取出 `VALUES` 列表里最外层的那些括号元组。
 *
 * 只用 `/\(([^()]*)\)/` 切不够：种子每个元组都以
 * `CAST(strftime('%s', 'now') AS INTEGER) * 1000` 结尾，里面那层括号会把元组切成
 * 两半，于是每行都过不了列数检查、重放出一棵空树。这里改成跟踪深度；字符串
 * 字面量内的括号跳过，于是名字里的 `)` 不会提前收尾；连写的 `''` 当转义引号。
 */
function valueTuples(values: string): string[] {
  const tuples: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (let index = 0; index < values.length; index += 1) {
    const character = values[index];
    if (quoted) {
      current += character;
      if (character === "'") {
        if (values[index + 1] === "'") {
          current += values[index + 1];
          index += 1;
        } else {
          quoted = false;
        }
      }
      continue;
    }
    if (character === "'") {
      quoted = true;
      current += character;
      continue;
    }
    if (character === "(") {
      depth += 1;
      if (depth === 1) {
        current = "";
        continue;
      }
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        tuples.push(current);
        current = "";
        continue;
      }
    }
    if (depth > 0) current += character;
  }
  return tuples;
}

/**
 * 桌面端页面节点，按迁移顺序重放：`INSERT` 加行，`UPDATE … SET … WHERE …` 改行，
 * `DELETE … WHERE code = '…'` 删行。只读 `INSERT` 不够——0129 用 `UPDATE` 重排
 * App 树、0133 整体回填 `path` / `entry_code`——否则大部分节点会被解析成没有路径的
 * 根行，两个检查（「挂在分组下」与守卫码比对）都会被静默跳过。
 *
 * 列按每条 `INSERT` 自己的列表取名字，不按位置：种子的列顺序并不一致（0127
 * 没有 `audience` 也没有 `path`；0145 起把 `path` 写在 `entry_code` 前）。按位置读
 * 一定会错位。
 */
function readPageNodes(): PageNode[] {
  const rows = new Map<string, PageNode>();
  // `ext_menu` 的菜单行：0133 的回填从这里读 `path` / `permission_code`，
  // 0168 删除该表后清空——但 0133 早已跑完，节点行里已经留着当时的取值。
  const menu = new Map<string, {path: string; entryCode: string | null}>();
  // 列清单整个捕获，包括 `id`：只抓 `id` 之后的列会让 `columns.length` 比元组的
  // 值个数少 1，列数校验恒不通过、回放得到空树。按名定位（`indexOf`）不依赖顺序。
  const insert = /INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+ext_permission_nodes\s*\((?<cols>[^)]*)\)\s*VALUES(?<values>[^;]*);/giu;
  const update = /UPDATE\s+ext_permission_nodes\s+SET\s+([^;]*?)\s+WHERE\s+([^;]*)/giu;
  // 两种删除形态都有：单码（`code = '…'`，0129 / 0131）与码表
  // （`code IN (…)`，0135 退役菜单管理时一次删掉页面节点与它的码叶子）。
  // 只认前者会让 0135 删掉的 `page_menu_management` 留在树里，测试随后去读一个
  // 已经被退役的页面文件。
  const remove = /DELETE\s+FROM\s+ext_permission_nodes\s+WHERE\s+(?:code\s*=\s*'(?<single>[^']+)'|code\s+IN\s*\((?<list>[^)]*)\))/giu;
  const menuInsert = /INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+ext_menu\s*\((?<cols>[^)]*)\)\s*VALUES(?<values>[^;]*);/giu;
  const menuUpdate = /UPDATE\s+ext_menu\s+SET\s+(?<set>[^;]*?)\s+WHERE\s+code\s*=\s*'(?<code>[^']+)'/giu;
  const menuDrop = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?ext_menu\b/iu;

  for (const name of migrationNames()) {
    // 行注释先剥掉再匹配：迁移里的 `-- rollback:` 块写的正是反向语句
    // （`DELETE FROM ext_permission_nodes WHERE code = '…'`），照原文跑会让回滚
    // 说明把刚插入的行删掉。与 `scripts/check-d1-scan.ts` 的抽取口径相同。
    const sql = readMigration(name).replaceAll(/--[^\n]*/gu, " ");
    for (const match of sql.matchAll(insert)) {
      const columns = (match.groups?.cols ?? "")
        .split(",")
        .map((column) => column.trim().replace(/^"|"$/gu, ""));
      const codeIndex = columns.indexOf("code");
      const kindIndex = columns.indexOf("kind");
      const parentIndex = columns.indexOf("parent_code");
      const pathIndex = columns.indexOf("path");
      const entryIndex = columns.indexOf("entry_code");
      const audienceIndex = columns.indexOf("audience");
      if (codeIndex < 0 || kindIndex < 0) continue;

      for (const tuple of valueTuples(match.groups?.values ?? "")) {
        const values = splitAssignments(tuple).map((value) => value.trim());
        // 0133's backfill subqueries sit inside an INSERT too; a tuple that does
        // not carry the declared column count is skipped rather than misread —
        // the UPDATE replay above is what fills those rows in.
        if (values.length !== columns.length) continue;
        const code = leadingLiteral(values[codeIndex] ?? "");
        if (!code) continue;
        if (leadingLiteral(values[kindIndex] ?? "") === "group") continue;
        rows.set(code, {
          code,
          parentCode: parentIndex < 0 ? null : nullableLiteral(values[parentIndex]),
          path: pathIndex < 0 ? "" : leadingLiteral(values[pathIndex] ?? ""),
          entryCode: entryIndex < 0 ? null : nullableLiteral(values[entryIndex]),
          // 0127 predates the column; every row it writes is a desktop node.
          audience: audienceIndex < 0
            ? "desktop"
            : leadingLiteral(values[audienceIndex] ?? "") || "desktop",
        });
      }
    }
    // 菜单行先于同文件的节点行写入之外，也可能被别的迁移改写（0050 设父级、
    // 0142 调整排序），所以每个迁移里都先回放菜单再回放节点。
    for (const match of sql.matchAll(menuInsert)) {
      const columns = (match.groups?.cols ?? "")
        .split(",")
        .map((column) => column.trim().replace(/^"|"$/gu, ""));
      const codeIndex = columns.indexOf("code");
      const pathIndex = columns.indexOf("path");
      const permissionIndex = columns.indexOf("permission_code");
      if (codeIndex < 0 || pathIndex < 0) continue;
      for (const tuple of valueTuples(match.groups?.values ?? "")) {
        const values = splitAssignments(tuple).map((value) => value.trim());
        if (values.length !== columns.length) continue;
        const code = leadingLiteral(values[codeIndex] ?? "");
        if (!code) continue;
        menu.set(code, {
          path: leadingLiteral(values[pathIndex] ?? ""),
          entryCode: permissionIndex < 0
            ? null
            : nullableLiteral(values[permissionIndex]),
        });
      }
    }
    for (const match of sql.matchAll(menuUpdate)) {
      const entry = menu.get(match.groups?.code ?? "");
      if (!entry) continue;
      const permission = /permission_code\s*=\s*(NULL|'[^']*')/iu
        .exec(match.groups?.set ?? "");
      if (permission) entry.entryCode = nullableLiteral(permission[1]);
    }
    for (const match of sql.matchAll(update)) {
      applyNodeUpdate(rows, match[1] ?? "", (match[2] ?? "").trim(), menu);
    }
    for (const match of sql.matchAll(remove)) {
      const single = match.groups?.single;
      if (single) {
        rows.delete(single);
        continue;
      }
      for (const literal of (match.groups?.list ?? "").matchAll(/'([^']+)'/gu)) {
        rows.delete(literal[1] ?? "");
      }
    }
    if (menuDrop.test(sql)) menu.clear();
  }
  // 只留桌面侧栏的页面节点：`app` 端有独立的分组（`group_app`）和自己的页面，
  // 它们不对应 `src/pages/[adminPath]` 下的任何一个 `.astro`。
  return [...rows.values()]
    .filter((row) => row.code.startsWith("page_") && row.audience === "desktop");
}

/**
 * 分组标题：页面挂在其下的那些节点。分组是标题不是页面——它没有 path、不绑
 * entry_code，所以页面守卫检查必须跳过它，改为断言这两条不变量。
 *
 * 这个集合按 `parent_code` 的指向推出来，不按 `group_` 名字前缀：节点种子里分组行
 * 与子行在同一张表，标记「这是标题」的是指向关系而不是命名习惯。`page_api`、
 * `page_settings`、`page_webhooks` 既是有守卫的页面、又挂着第三层条目，它们仍须
 * 按页面被检查。
 */
function groupCodesOf(pages: PageNode[]): Set<string> {
  return new Set(
    pages
      .map((page) => page.parentCode)
      .filter((code): code is string => code !== null),
  );
}

function pageSource(menuPath: string): string {
  const file = menuPath === ""
    ? join(PAGES, "index.astro")
    : join(PAGES, `${menuPath}/index.astro`);
  return readFileSync(file, "utf8");
}

/** Resolve the code a `requirePagePermission` call guards with. */
function pageGuardCode(source: string): string | null {
  const lit = /requirePagePermission\(\s*Astro\.locals,\s*"([^"]+)"/u
    .exec(source);
  if (lit?.[1]) return lit[1];
  const key = /requirePagePermission\(\s*Astro\.locals,\s*PERMISSION_CODES\.([A-Za-z_][A-Za-z0-9_]*)/u
    .exec(source);
  if (key?.[1]) {
    return PERMISSION_CODES[key[1] as keyof typeof PERMISSION_CODES];
  }
  return null;
}

/** Every `.astro` under the admin area that guards itself, with its code. */
function guardedPages(dir: string): Array<{file: string; code: string}> {
  const found: Array<{file: string; code: string}> = [];
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...guardedPages(full));
      continue;
    }
    if (!entry.name.endsWith(".astro")) continue;
    const source = readFileSync(full, "utf8");
    const code = pageGuardCode(source);
    if (code) found.push({code, file: full});
  }
  return found;
}

describe("menu page guards", () => {
  const pages = readPageNodes();
  const groupSet = groupCodesOf(pages);

  it("parses the seeded page nodes", () => {
    // The sidebar links 30 page nodes; anything far below that means the replay
    // stopped reading inserts early and the guard comparison below would pass
    // on a fraction of the tree.
    expect(pages.length).toBeGreaterThanOrEqual(25);
    // Home is synthesised by `buildSidebarItems` and binds no code.
    expect(pages.some((page) => page.entryCode === null)).toBe(true);
    expect([...groupSet].sort()).toEqual([
      "group_account",
      "group_content",
      "group_integration",
      "group_operations",
      "group_review",
      "group_site",
    ]);
  });

  it("hangs every child row off a group row that exists", () => {
    let parented = 0;
    for (const page of pages) {
      if (page.parentCode === null) continue;
      parented += 1;
      expect(
        groupSet.has(page.parentCode),
        `${page.code} hangs off ${page.parentCode}, which is not a group row`,
      ).toBe(true);
    }
    // Almost every page is re-parented by an `UPDATE` (0129, 0131, 0142), so
    // this is only non-trivial when the parser replays the updates. Without it
    // `parented` would be small and the loop above would assert nothing.
    expect(parented).toBeGreaterThan(20);
  });

  it("guards every page node with the code its entry binds", () => {
    for (const page of pages) {
      const source = pageSource(page.path);
      if (page.entryCode === null) {
        expect(
          source.includes("requirePagePermission"),
          `public menu ${page.code} must not guard its page`,
        ).toBe(false);
        continue;
      }
      expect(
        pageGuardCode(source) === page.entryCode,
        `page for menu ${page.code} must guard with ${page.entryCode}`,
      ).toBe(true);
    }
  });

  it("never guards a page with a code no entry binds", () => {
    const bound = new Set(
      pages
        .map((page) => page.entryCode)
        .filter((code): code is string => code !== null),
    );
    const guarded = guardedPages(PAGES);
    // Detail pages (item editor, page editor, …) reuse the code of the menu
    // they belong to, so there are more guarded files than sidebar entries.
    expect(guarded.length).toBeGreaterThan(pages.length);
    for (const page of guarded) {
      expect(
        bound.has(page.code),
        `${page.file} guards with ${page.code}, which no page node binds`,
      ).toBe(true);
    }
  });
});

/** Every `.astro` under the admin area, whether or not it guards. */
function allAstroFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...allAstroFiles(full));
    else if (entry.name.endsWith(".astro")) found.push(full);
  }
  return found;
}

/**
 * 页面守卫登记表 `ADMIN_PAGE_GUARDS`（`src/shared/AdminPageGuards.ts`）与真实
 * 页面文件的双向一致（方向 1，2026-11）。目录是只读的——运行时权威仍在各页面
 * 自己的 `requirePagePermission` 调用——所以这里只核对两套事实重合：
 *   - 目录里每一页都能在文件树上找到并守卫同一码（无孤儿条目）；
 *   - 每个守卫页都登记在目录里（无漏记条目）；
 *   - 每个真的调用 `requirePagePermission` 的页面都能被解析出来（否则漏记
 *     断言会被静默绕过——解析失败的页面根本进不了 `actual`）。
 * 改页面守卫码而忘同步目录，或反过来，都会在这一组直接红。
 */
describe("admin page guard catalog", () => {
  const actual = new Map<string, string>();
  for (const page of guardedPages(PAGES)) {
    const rel = relative(PAGES, page.file)
      .replace(/\\/gu, "/")
      .replace(/\/index\.astro$/u, "");
    actual.set(rel, page.code);
  }

  it("covers every guarded page (no missing entries)", () => {
    for (const [rel, code] of actual) {
      expect(
        ADMIN_PAGE_GUARDS[rel],
        `${rel} is guarded but absent from ADMIN_PAGE_GUARDS`,
      ).toBe(code);
    }
  });

  it("contains no orphan entries (no page-less codes)", () => {
    for (const [rel, code] of Object.entries(ADMIN_PAGE_GUARDS)) {
      expect(
        actual.get(rel),
        `${rel} is in ADMIN_PAGE_GUARDS but no page guards with it`,
      ).toBe(code);
    }
  });

  it("parses every page that calls requirePagePermission", () => {
    const unparsed: string[] = [];
    for (const file of allAstroFiles(PAGES)) {
      const source = readFileSync(file, "utf8");
      if (
        /requirePagePermission\s*\(/u.test(source) &&
        !pageGuardCode(source)
      ) {
        unparsed.push(relative(PAGES, file).replace(/\\/gu, "/"));
      }
    }
    expect(
      unparsed,
      `pages call requirePagePermission but cannot be parsed: ${unparsed.join(", ")}`,
    ).toEqual([]);
  });
});
