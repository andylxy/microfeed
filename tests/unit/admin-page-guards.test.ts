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
 * The menu rows live in migration 0041, so this reads them from there rather
 * than from a second list that could go stale.
 */

const MENU_SQL = "migrations/0041_ext_menu.sql";
const PAGES = join("src", "pages", "[adminPath]");

interface MenuRow {
  code: string;
  path: string;
  permissionCode: string | null;
}

function readMenuRows(): MenuRow[] {
  const sql = readFileSync(MENU_SQL, "utf8");
  const rows: MenuRow[] = [];
  const tuple = /\(\s*'[^']+'\s*,\s*'(?<code>[^']+)'\s*,\s*(?:NULL|'[^']*')\s*,\s*'(?<path>[^']*)'\s*,\s*'[^']+'\s*,\s*(?:NULL|'[^']*')\s*,\s*(?<perm>NULL|'(?<permCode>[^']+)')/gu;
  for (const match of sql.matchAll(tuple)) {
    rows.push({
      code: match.groups?.code ?? "",
      path: match.groups?.path ?? "",
      permissionCode: match.groups?.permCode ?? null,
    });
  }
  return rows;
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

  it("parses the seeded menu rows", () => {
    expect(rows.length).toBeGreaterThanOrEqual(16);
    expect(rows.some((row) => row.permissionCode === null)).toBe(true);
  });

  it("guards every menu page with the code its menu row binds", () => {
    for (const row of rows) {
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
      rows
        .map((row) => row.permissionCode)
        .filter((code): code is string => code !== null),
    );
    const guarded = guardedPages(PAGES);
    // Detail pages (item editor, page editor, …) reuse the code of the menu
    // they belong to, so there are more guarded files than menu rows.
    expect(guarded.length).toBeGreaterThan(rows.length);
    for (const page of guarded) {
      expect(
        bound.has(page.code),
        `${page.file} guards with ${page.code}, which no menu row binds`,
      ).toBe(true);
    }
  });
});
