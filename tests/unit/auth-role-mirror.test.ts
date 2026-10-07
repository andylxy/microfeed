/**
 * `auth_user.role` is a *derived mirror* of the RBAC `super_admin` grant, not an
 * independent authorization source (ADR-0011 D4; `BETTER_AUTH_ADMIN_ROLE` in
 * `src/shared/Rbac.ts`).
 *
 * Better Auth's own admin plugin reads that column, so it has to stay in step
 * with `ext_user_roles`. A second code path that wrote it without touching the
 * RBAC tables would silently split authorization in two — the exact drift D4
 * warns about. This is the tripwire: it pins every writer of the column, so a
 * new one fails the suite and forces a review instead of a quiet divergence.
 */
import {readdir, readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const sourceRoot = path.join(repositoryRoot, "src");

/**
 * `UPDATE ["<"]auth_user[">] SET ["<"]role[">] =` — the mirror write. Quotes are
 * optional on both identifiers so a quoted variant (the repo already writes
 * `INSERT INTO "auth_user"`) cannot slip past the tripwire.
 */
const MIRROR_WRITE = /UPDATE\s+"?auth_user"?\s+SET\s+"?role"?\s*=/giu;

/** `INSERT INTO ["<"]auth_user` — the account-creation write. */
const USER_INSERT = /INSERT\s+INTO\s+"?auth_user\b/giu;

/**
 * The mapping every mirror write must carry: holding `super_admin` becomes the
 * Better Auth admin role, anything else the plain user role. Pinning the whole
 * ternary — not just "the file mentions the constants" — is what stops a flipped
 * mapping from passing.
 */
const MIRROR_MAPPING =
  /includes\(SUPER_ADMIN\)\s*\?\s*BETTER_AUTH_ADMIN_ROLE\s*:\s*BETTER_AUTH_USER_ROLE/gu;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {withFileTypes: true});
  const files = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(filename);
      }
      return /\.tsx?$/u.test(entry.name) ? [filename] : [];
    }),
  );
  return files.flat();
}

/** Files under `src/` whose text matches `pattern`, relative to the repo root. */
async function writersOf(pattern: RegExp): Promise<string[]> {
  const files = await sourceFiles(sourceRoot);
  const hits: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    // The patterns are global, so `test` advances `lastIndex`; reset per file.
    pattern.lastIndex = 0;
    if (pattern.test(source)) {
      hits.push(path.relative(repositoryRoot, file));
    }
  }
  return hits.sort();
}

describe("auth_user.role stays a derived mirror of the RBAC super_admin grant", () => {
  it("mutates the mirror column only in rbac-handlers.ts", async () => {
    const writers = await writersOf(MIRROR_WRITE);
    expect(writers).toEqual([
      path.join("src", "server", "admin", "rbac-handlers.ts"),
    ]);

    const source = await readFile(
      path.join(sourceRoot, "server", "admin", "rbac-handlers.ts"),
      "utf8",
    );
    // Exactly two mirror writes — `replaceUserRoles` and `createAdminRbacUser` —
    // and each one carries the super_admin -> admin mapping. A flipped or dropped
    // mapping fails here rather than silently authorizing the wrong way.
    expect(source.match(MIRROR_WRITE) ?? []).toHaveLength(2);
    expect(source.match(MIRROR_MAPPING) ?? []).toHaveLength(2);
  });

  it("creates an auth_user row with a role only in the two owner paths", async () => {
    const writers = await writersOf(USER_INSERT);
    expect(writers).toEqual([
      path.join("src", "server", "auth", "bootstrap.ts"),
      path.join("src", "server", "auth", "password-setup.ts"),
    ]);
  });
});
