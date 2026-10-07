import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";

import {describe, expect, it} from "vitest";

import {migrationNames, readMigration} from "./support/migrations";
import {PERMISSION_CODES} from "../../src/shared/Constants";

/**
 * The consistency red line from the menu design: a menu row binds a permission
 * code, and the page it points at must guard with **the same code**. Drift in
 * either direction is a bad experience that no other test catches — the menu
 * would show a link that 403s, or hide a page the account may open.
 *
 * The menu rows live in migrations (0041 seeded them; 0050 groups them, and
 * later feature migrations add rows, re-parent them and delete them again), so
 * this replays every migration that touches `ext_menu` — inserts, updates and
 * deletes, in order — rather than reading a second list, or a single file, that
 * could go stale. Replaying the updates matters: most `parent_code`s are set by
 * `UPDATE` (0050 re-parents every 0041 page), so reading only the inserts left
 * those rows parentless and silently skipped the "hangs off a group" check.
 */

const PAGES = join("src", "pages", "[adminPath]");

interface MenuRow {
  code: string;
  parentCode: string | null;
  path: string;
  permissionCode: string | null;
}

/** `NULL` (or an empty literal) stays null; a quoted literal loses its quotes. */
function nullableLiteral(raw: string | undefined): string | null {
  if (!raw || raw === "NULL" || raw === "''") return null;
  return raw.slice(1, -1);
}

/**
 * Split a `SET` clause into its assignments on the commas that separate them —
 * not a comma inside a quoted value, which a plain `split(",")` would break on.
 */
function splitAssignments(clause: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (const character of clause) {
    if (character === "'") quoted = !quoted;
    if (character === "," && !quoted) {
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
 * Apply the `SET …` clause of an `UPDATE ext_menu` to one row.
 *
 * Only the columns this test reads are tracked; `sort`, `icon` and `is_visible`
 * are ignored on purpose. An assignment whose value is a bare number (e.g.
 * `sort = 601`) is skipped, which is why the value pattern is `NULL|'…'`.
 */
function applyMenuAssignments(row: MenuRow, assignments: string): void {
  for (const assignment of splitAssignments(assignments)) {
    const parsed = /^\s*(?<column>[a-z_]+)\s*=\s*(?<value>NULL|'[^']*')\s*$/iu
      .exec(assignment);
    const column = parsed?.groups?.column;
    if (!column) continue;
    const value = nullableLiteral(parsed?.groups?.value);
    if (column === "parent_code") row.parentCode = value;
    else if (column === "permission_code") row.permissionCode = value;
    else if (column === "path") row.path = value ?? "";
  }
}

/**
 * Apply one `UPDATE ext_menu SET … WHERE …`.
 *
 * Two predicate shapes exist across the migrations, and both are modelled: a
 * single row named by `code` — 0065 appends `AND sort = 503`, a column this
 * test does not track, so the extra condition is ignored — and a prefix rewrite
 * of `permission_code` (`SET permission_code = REPLACE(permission_code, 'A',
 * 'B') WHERE permission_code LIKE 'P%'`; 0067 repairs the codes 0057 renamed).
 * Anything else throws instead of being skipped: an ignored UPDATE is exactly
 * how this parser would start comparing pages against a stale menu.
 */
function applyMenuUpdate(
  rows: Map<string, MenuRow>,
  assignments: string,
  predicate: string,
): void {
  const byCode = /^code\s*=\s*'([^']+)'/iu.exec(predicate);
  if (byCode) {
    const row = rows.get(byCode[1] ?? "");
    if (row) applyMenuAssignments(row, assignments);
    return;
  }
  const prefix = /^permission_code\s+LIKE\s+'([^']*)%'$/iu.exec(predicate);
  const replace = /^permission_code\s*=\s*REPLACE\(\s*permission_code\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)$/iu
    .exec(assignments.trim());
  if (prefix && replace) {
    const from = replace[1] ?? "";
    const to = replace[2] ?? "";
    for (const row of rows.values()) {
      if (row.permissionCode?.startsWith(prefix[1] ?? "")) {
        row.permissionCode = row.permissionCode.split(from).join(to);
      }
    }
    return;
  }
  throw new Error(
    `unhandled ext_menu UPDATE: SET ${assignments} WHERE ${predicate}`,
  );
}

/**
 * The menu's final rows, replayed in migration order: an `INSERT` adds rows, an
 * `UPDATE … SET … WHERE code = '…'` mutates one, a `DELETE … WHERE code = '…'`
 * removes one. Reading the inserts alone is not enough — 0050 re-parents every
 * 0041 page with `UPDATE`s, and 0069/0089 move more — so most `parent_code`s
 * never appear in an `INSERT` and those rows would otherwise parse as roots,
 * silently skipping the "hangs off a group" check.
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
  const rows = new Map<string, MenuRow>();
  const insert = /INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+ext_menu\s*\([^;]*;/giu;
  const update = /UPDATE\s+ext_menu\s+SET\s+([^;]*?)\s+WHERE\s+([^;]*)/giu;
  const remove = /DELETE\s+FROM\s+ext_menu\s+WHERE\s+code\s*=\s*'([^']+)'/giu;
  const tuple = /\(\s*'[^']+'\s*,\s*'(?<code>[^']+)'\s*,\s*(?<parent>NULL|'[^']*')\s*,\s*'(?<path>[^']*)'\s*,\s*'[^']+'\s*,\s*(?:NULL|'[^']*')\s*,\s*(?<perm>NULL|'(?<permCode>[^']+)')/gu;

  for (const name of migrationNames()) {
    const sql = readMigration(name);
    for (const statement of sql.matchAll(insert)) {
      for (const match of statement[0].matchAll(tuple)) {
        const code = match.groups?.code ?? "";
        rows.set(code, {
          code,
          parentCode: nullableLiteral(match.groups?.parent),
          path: match.groups?.path ?? "",
          permissionCode: match.groups?.permCode ?? null,
        });
      }
    }
    for (const match of sql.matchAll(update)) {
      applyMenuUpdate(rows, match[1] ?? "", (match[2] ?? "").trim());
    }
    for (const match of sql.matchAll(remove)) {
      rows.delete(match[1] ?? "");
    }
  }
  return [...rows.values()];
}

/**
 * The group headings: the `group_`-prefixed rows (0050 — "Codes are prefixed
 * `group_` because `ext_menu.code` is UNIQUE and the page codes are already
 * taken"). A group is a heading, not a page: it has no path and binds no
 * permission, so the page-guard checks must skip it and assert those invariants
 * instead.
 *
 * A group is recognised by the prefix rather than by "is it a parent": the
 * `parent_code` link is real now that the parser replays the `UPDATE`s, but
 * deriving the groups from it would couple two checks that are clearer apart.
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
    let parented = 0;
    for (const row of rows) {
      if (row.parentCode === null) continue;
      parented += 1;
      expect(
        groupSet.has(row.parentCode),
        `${row.code} hangs off ${row.parentCode}, which is not a group row`,
      ).toBe(true);
    }
    // Almost every page is re-parented by an `UPDATE` (0050), so this is only
    // non-trivial when the parser replays the updates. Without it `parented`
    // would be 0 and the loop above would assert nothing — the check this
    // guard exists for.
    expect(parented).toBeGreaterThan(20);
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
