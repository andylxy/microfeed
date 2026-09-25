import {readdirSync, readFileSync} from "node:fs";
import {join, relative} from "node:path";

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
const ADMIN_PAGES = join("src", "pages", "[adminPath]");
const AJAX = join(ADMIN_PAGES, "ajax");
const SERVER_ADMIN = join("src", "server", "admin");

/** Every permission code present in `ext_permissions` after all migrations run. */
function readCatalogCodes(): Set<string> {
  const codes = new Set<string>();
  const files = readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    // A later migration may retire codes an earlier one seeded, e.g.
    // `DELETE FROM ext_permissions WHERE code IN (…)` or `… code LIKE 'api:%'`
    // (ADR-0009 dropped the `api:*` family). Migrations run in filename order,
    // so apply removals before additions for each file.
    for (const match of sql.matchAll(
      /DELETE\s+FROM\s+ext_permissions[\s\S]*?code\s+(?:IN\s*\((?<list>[^)]*)\)|LIKE\s*'(?<prefix>[^']+)')/giu,
    )) {
      const list = match.groups?.list;
      if (list) {
        for (const literal of list.matchAll(/'([^']+)'/gu)) {
          codes.delete(literal[1]!);
        }
      }
      const prefix = match.groups?.prefix;
      if (prefix?.endsWith("%")) {
        const stem = prefix.slice(0, -1);
        for (const code of [...codes]) {
          if (code.startsWith(stem)) codes.delete(code);
        }
      }
    }
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
    // Pins a few long-lived codes so a parser that silently matched nothing
    // (leaving just the wildcard) fails here instead of passing vacuously; the
    // exact set is pinned by the equality test below.
    expect(catalog.size).toBeGreaterThanOrEqual(20);
    for (const code of ["*", "content:book:read", "system:role:manage"]) {
      expect(catalog.has(code)).toBe(true);
    }
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

  it("guards every admin endpoint outside the session-only list (A2)", () => {
    // A2's finding was six bare webhook read endpoints, but the defect class is
    // "an admin endpoint reachable with no RBAC check", so the sweep covers the
    // whole admin surface — `ajax/**` plus the handful of non-ajax endpoints
    // (`feed/json.ts`, `items/index.ts`, …).
    //
    // A file that declares methods counts as guarded when either it guards
    // itself (`requireRbac` / `withRbacGuard` / `withWebhookGuard`) or it is a
    // thin re-export of a module that does — `ajax/rbac/*` re-exports
    // `rbac-handlers`, which guards each handler. A bare re-export of an
    // *unguarded* module is exactly the shape A2 removed, and still fails here.
    //
    // Two exemption classes, each with its reason; nothing else may skip a guard:
    //   - session-only endpoints (the account manages its own state; the
    //     pre-authentication flows issue sessions), and
    //   - redirect shims (302 into the admin UI, no data access).
    const SESSION_ONLY: ReadonlyArray<[prefix: string, why: string]> = [
      ["ajax/account/", "self-service: the account manages its own sessions, passkeys, email and password"],
      ["ajax/auth/credential-login.ts", "pre-authentication: exchanges a credential for a session"],
      ["login/", "pre-authentication: token-based password setup"],
    ];
    const REDIRECT_ONLY: ReadonlyArray<[file: string, why: string]> = [
      ["channels/index.ts", "302 redirect into the admin UI"],
      ["items/index.ts", "302 redirect into the admin UI"],
    ];
    const declaredMethods = /export\s+const\s+(GET|POST|PUT|DELETE|PATCH)\b/gu;
    const reExportedMethods = /export\s*\{\s*[^}]*\s+as\s+(GET|POST|PUT|DELETE|PATCH)\b/gu;
    const hasGuard = /requireRbac\(|withRbacGuard\(|withWebhookGuard\(/u;

    /** Does a module this file re-exports from guard its handlers? */
    const reExportTargetGuarded = (source: string): boolean => {
      for (const match of source.matchAll(/from\s+"(@\/[^"]+)"/gu)) {
        const base = join("src", match[1]!.slice(2));
        for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
          try {
            if (hasGuard.test(readFileSync(candidate, "utf8"))) return true;
          } catch {
            // Not a file (a `.tsx` module, say) — keep looking.
          }
        }
      }
      return false;
    };

    const unguarded: string[] = [];
    let scanned = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, {withFileTypes: true})) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!full.endsWith(".ts")) continue;
        const name = relative(ADMIN_PAGES, full).replaceAll("\\", "/");
        if (SESSION_ONLY.some(([prefix]) => name.startsWith(prefix))) continue;
        if (REDIRECT_ONLY.some(([file]) => name === file)) continue;
        const source = readFileSync(full, "utf8");
        const declares = declaredMethods.test(source) ||
          reExportedMethods.test(source);
        // Reset the sticky `g` flag so the next file starts clean.
        declaredMethods.lastIndex = 0;
        reExportedMethods.lastIndex = 0;
        if (!declares) continue;
        scanned += 1;
        if (!hasGuard.test(source) && !reExportTargetGuarded(source)) {
          unguarded.push(name);
        }
      }
    };
    walk(ADMIN_PAGES);
    // A lower bound keeps the sweep honest — a bad root would find nothing.
    expect(scanned).toBeGreaterThanOrEqual(30);
    expect(
      unguarded,
      `admin endpoints with no RBAC guard: ${unguarded.join(", ")}`,
    ).toEqual([]);
  });
});
