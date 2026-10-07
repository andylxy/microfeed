import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";

import {describe, expect, it} from "vitest";

import {PERMISSION_CODES} from "../../src/shared/Constants";

/**
 * The consistency red line from the menu design: a menu row binds a permission
 * code, and the page it points at must guard with **the same code**. Drift in
 * either direction is a bad experience that no other test catches — the menu
 * would show a link that 403s, or hide a page the account may open.
 *
 * The menu rows live in migrations (0041 seeded them; 0050 groups them, and
 * later feature migrations add rows and delete them again), so this reads every
 * migration that touches `ext_menu` — inserts and deletes — rather than from a
 * second list — or a single file — that could go stale.
 */

const PAGES = join("src", "pages", "[adminPath]");

interface MenuRow {
  code: string;
  parentCode: string | null;
  path: string;
  permissionCode: string | null;
}

/** Every migration file, oldest first. */
function migrationSql(): string {
  return readdirSync("migrations")
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(join("migrations", name), "utf8"))
    .join("\n");
}

/** Menu-row inserts, oldest first. The precise table pattern keeps
 *  `ext_menu_permissions` inserts out of the match. */
function menuMigrationSql(): string {
  const insertsMenuRow = /INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+ext_menu\s*\(/u;
  return readdirSync("migrations")
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(join("migrations", name), "utf8"))
    .filter((sql) => insertsMenuRow.test(sql))
    .join("\n");
}

/**
 * Menu codes a later migration deletes (migration 0064 dropped the duplicate
 * RBAC board page). A row that is gone must stop being required to have a page,
 * and its code must stop being treated as "bound" — otherwise removing a page
 * would fail this file instead of the menu's own consistency check.
 */
function deletedMenuCodes(): Set<string> {
  const codes = new Set<string>();
  const byCode = /DELETE\s+FROM\s+ext_menu\s+WHERE\s+code\s*=\s*'(?<code>[^']+)'/gu;
  for (const match of migrationSql().matchAll(byCode)) {
    if (match.groups?.code) codes.add(match.groups.code);
  }
  return codes;
}

/** `NULL` (or an empty literal) stays null; a quoted literal loses its quotes. */
function nullableLiteral(raw: string | undefined): string | null {
  if (!raw || raw === "NULL" || raw === "''") return null;
  return raw.slice(1, -1);
}

/**
 * Menu rows from every migration that inserts one.
 *
 * The `icon` field accepts `NULL` as well as a quoted name on purpose: 0050
 * seeds the group headings with a NULL icon and 0051 fills them in with an
 * UPDATE, so a pattern that only accepted a quoted icon silently dropped every
 * group row from this parser — the group headings were never checked at all,
 * and the first group row to carry an icon inline (0089) was then read as a
 * *page* whose path is `''`. Accepting NULL restores them; `isGroupCode` below
 * tells the two kinds apart.
 */
function readMenuRows(): MenuRow[] {
  const sql = menuMigrationSql();
  const deleted = deletedMenuCodes();
  const rows: MenuRow[] = [];
  const tuple = /\(\s*'[^']+'\s*,\s*'(?<code>[^']+)'\s*,\s*(?<parent>NULL|'[^']*')\s*,\s*'(?<path>[^']*)'\s*,\s*'[^']+'\s*,\s*(?:NULL|'[^']*')\s*,\s*(?<perm>NULL|'(?<permCode>[^']+)')/gu;
  for (const match of sql.matchAll(tuple)) {
    const code = match.groups?.code ?? "";
    if (deleted.has(code)) continue;
    rows.push({
      code,
      parentCode: nullableLiteral(match.groups?.parent),
      path: match.groups?.path ?? "",
      permissionCode: match.groups?.permCode ?? null,
    });
  }
  return rows;
}

/**
 * The group headings: the `group_`-prefixed rows (0050 — "Codes are prefixed
 * `group_` because `ext_menu.code` is UNIQUE and the page codes are already
 * taken"). A group is a heading, not a page: it has no path and binds no
 * permission, so the page-guard checks must skip it and assert those invariants
 * instead.
 *
 * Note this cannot be derived from the parsed `parent_code`s: 0050 hangs the
 * existing pages off its groups with `UPDATE`s, and this parser only reads
 * `INSERT` tuples, so most parents never appear as a child's `parent_code`.
 */
const GROUP_CODE_PREFIX = "group_";

function isGroupCode(code: string): boolean {
  return code.startsWith(GROUP_CODE_PREFIX);
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
  const rows = readMenuRows();
  const groupSet = new Set(
    rows.filter((row) => isGroupCode(row.code)).map((row) => row.code),
  );
  /** Rows that are pages, i.e. everything that is not a group heading. */
  const pages = rows.filter((row) => !groupSet.has(row.code));

  it("parses the seeded menu rows, group headings included", () => {
    expect(rows.length).toBeGreaterThanOrEqual(16);
    expect(rows.some((row) => row.permissionCode === null)).toBe(true);
    // 0050 seeds five group headings and 0089 adds `group_operations`. This set
    // must not be empty: the old pattern required a quoted `icon`, so 0050's
    // `icon = NULL` group rows were dropped and no group was ever checked.
    expect([...groupSet].sort()).toEqual([
      "group_account",
      "group_content",
      "group_integration",
      "group_operations",
      "group_review",
      "group_site",
    ]);
  });

  it("treats a group heading as a heading, not a page", () => {
    for (const code of groupSet) {
      const row = rows.find((entry) => entry.code === code);
      expect(row, `group ${code} has no row`).toBeDefined();
      expect(row?.path, `group ${code} must not have a path`).toBe("");
      expect(
        row?.permissionCode,
        `group ${code} must not bind a code`,
      ).toBeNull();
    }
  });

  it("hangs every child row off a group row that exists", () => {
    for (const row of rows) {
      if (row.parentCode === null) continue;
      expect(
        groupSet.has(row.parentCode),
        `${row.code} hangs off ${row.parentCode}, which is not a group row`,
      ).toBe(true);
    }
  });

  it("guards every menu page with the code its menu row binds", () => {
    for (const row of pages) {
      const source = pageSource(row.path);
      if (row.permissionCode === null) {
        expect(
          source.includes("requirePagePermission"),
          `public menu ${row.code} must not guard its page`,
        ).toBe(false);
        continue;
      }
      expect(
        pageGuardCode(source) === row.permissionCode,
        `page for menu ${row.code} must guard with ${row.permissionCode}`,
      ).toBe(true);
    }
  });

  it("never guards a page with a code no menu binds", () => {
    const bound = new Set(
      pages
        .map((row) => row.permissionCode)
        .filter((code): code is string => code !== null),
    );
    const guarded = guardedPages(PAGES);
    // Detail pages (item editor, page editor, …) reuse the code of the menu
    // they belong to, so there are more guarded files than menu pages. Groups
    // are headings, not pages, so they are not part of the comparison.
    expect(guarded.length).toBeGreaterThan(pages.length);
    for (const page of guarded) {
      expect(
        bound.has(page.code),
        `${page.file} guards with ${page.code}, which no menu row binds`,
      ).toBe(true);
    }
  });
});
