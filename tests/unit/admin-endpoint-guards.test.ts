import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";

import {describe, expect, it} from "vitest";

import {PERMISSION_CODES} from "../../src/shared/Constants";

/**
 * The endpoint half of the menu/guard consistency red line.
 *
 * `tests/unit/admin-page-guards.test.ts` already pins pages: a menu row's
 * `permission_code` must equal the code its page guards with. Endpoints were not
 * pinned, so a guard requiring a code no catalog row defines — a typo, or a code
 * renamed in `ext_permissions` but not here — silently 403s for everyone (or
 * grants nothing). This catches that drift at the unit level, before deploy.
 *
 * The catalog of valid codes is parsed straight from the SQL seeds (the same
 * source the worker test asserts `RBAC_PERMISSIONS` mirrors), so this test needs
 * no second hand-maintained list. We also assert `PERMISSION_CODES` — the typed
 * surface the guards accept — stays equal to that catalog, closing the loop on
 * the "unified constant" work: the canonical list can neither gain a phantom nor
 * lose a real code without this test failing.
 */

const MIGRATIONS = "migrations";
const AJAX = join("src", "pages", "[adminPath]", "ajax");
const SERVER_ADMIN = join("src", "server", "admin");

/** Every permission code seeded into `ext_permissions` across all migrations. */
function readCatalogCodes(): Set<string> {
  const codes = new Set<string>();
  for (const file of readdirSync(MIGRATIONS)) {
    if (!file.endsWith(".sql")) continue;
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    // Matches `('p_<id>', '<code>', '<name>')` tuples in the permission seed.
    for (const match of sql.matchAll(
      /\(\s*'p_[^']*'\s*,\s*'(?<code>[^']+)'\s*,\s*'[^']*'\s*\)/gu,
    )) {
      if (match.groups?.code) codes.add(match.groups.code);
    }
  }
  return codes;
}

/**
 * Every permission code an endpoint guard actually requires.
 *
 * Guards may pass the code either as a `PERMISSION_CODES.KEY` reference (the
 * canonical form after the naming-convergence work) or as a bare string
 * literal — both are accepted so the assertion stays honest whichever style a
 * contributor uses.
 */
function guardCodesIn(dir: string): string[] {
  const codes: string[] = [];
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      codes.push(...guardCodesIn(full));
      continue;
    }
    if (!full.endsWith(".ts")) continue;
    const source = readFileSync(full, "utf8");
    const patterns = [
      /requireRbac\(\s*[^,]*,\s*PERMISSION_CODES\.([A-Za-z_][A-Za-z0-9_]*)/gu,
      /requireRbac\(\s*[^,]*,\s*"([^"]+)"/gu,
      /withRbacGuard\(\s*[^,]*,\s*PERMISSION_CODES\.([A-Za-z_][A-Za-z0-9_]*)/gu,
      /withRbacGuard\(\s*[^,]*,\s*"([^"]+)"/gu,
    ];
    for (const re of patterns) {
      for (const match of source.matchAll(re)) {
        const token = match[1];
        if (!token) continue;
        if (/^[A-Z][A-Z0-9_]*$/.test(token)) {
          // PERMISSION_CODES.KEY form: resolve through the typed map.
          codes.push(PERMISSION_CODES[token as keyof typeof PERMISSION_CODES]);
        } else {
          codes.push(token);
        }
      }
    }
  }
  return codes;
}

describe("admin endpoint guards", () => {
  const catalog = readCatalogCodes();

  it("seeds a non-empty permission catalog from the migrations", () => {
    expect(catalog.size).toBeGreaterThanOrEqual(35);
    expect(catalog.has("*")).toBe(true);
  });

  it("keeps PERMISSION_CODES equal to the SQL permission catalog", () => {
    const constants = new Set(Object.values(PERMISSION_CODES));
    expect([...constants].sort()).toEqual([...catalog].sort());
  });

  it("guards every endpoint with a real catalog permission code", () => {
    const codes = guardCodesIn(AJAX).concat(guardCodesIn(SERVER_ADMIN));
    // The ajax layer alone carries the endpoint guards the design sized; a lower
    // bound keeps the scan honest (it must have actually found guards).
    expect(codes.length).toBeGreaterThanOrEqual(27);
    for (const code of codes) {
      expect(
        catalog.has(code),
        `${code} is required by an endpoint guard but is not a seeded permission code`,
      ).toBe(true);
    }
  });
});
