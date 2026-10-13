/**
 * Verifies migration file hygiene for the microfeed repo.
 *
 * Four rules are enforced (matching the four bullets in AGENTS.md
 * 「架构治理 → 迁移命名与回滚」):
 *
 *   MIG-001  编号连续。From 0108 onward the numbers must be contiguous with no
 *             gaps. Historical gaps below the frozen boundary are expected:
 *             migrations 0044, 0047, 0048 and 0049 were consolidated into
 *             later ones during the RBAC rework, so only 0108+ is enforced.
 *             Also checks that every file name starts with a 4-digit number.
 *
 *   MIG-002  文件名冻结。Files numbered 0001–0107 are listed verbatim in
 *             `scripts/frozen-migration-names.txt`. Wrangler uses the file
 *             name as the `d1_migrations` bookkeeping key, so renaming one
 *             makes the applied entry unrecognisable and the migration would
 *             run twice on the next `wrangler d1 migrations apply`. The rule
 *             catches both a rename (a frozen name missing from disk) and a
 *             new file squatting a frozen number.
 *
 *   MIG-003  命名分类。From 0108 onward the file name must be
 *             `NNNN_<type>_<desc>.sql` with `<type>` one of:
 *             schema, index, data, seed, cleanup. The type lets a reviewer
 *             spot a data migration in a file-name scan without opening it.
 *
 *   MIG-004  回滚说明。From 0108 onward, `data` and `cleanup` migrations must
 *             contain a `-- rollback:` comment block. Schema and index
 *             migrations are reversible by their own nature (drop the
 *             column/index), so they are exempt.
 *
 * The frozen-name list is data, not logic: it lives in its own file so a
 * change to it shows up as a reviewable one-line diff.
 *
 * Run with `yarn migrations:check`. It exits non-zero when any rule is violated.
 */
import {readFileSync, readdirSync, existsSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {report, finish} from "./gate-utils";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationsRoot = path.join(repositoryRoot, "migrations");
const frozenListPath = path.join(repositoryRoot, "scripts", "frozen-migration-names.txt");

const FROZEN_UPPER_BOUND = 107;
const ENFORCED_LOWER_BOUND = 108;
const ALLOWED_TYPES = ["schema", "index", "data", "seed", "cleanup"];
const TYPES_REQUIRING_ROLLBACK = new Set(["data", "cleanup"]);

const migrationFiles = existsSync(migrationsRoot)
  ? readdirSync(migrationsRoot).filter((name) => name.endsWith(".sql")).sort()
  : [];

const frozenNames = new Set(
  readFileSync(frozenListPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean),
);

// Rule MIG-001: file name shape, duplicate numbers, and contiguity from the
// enforced boundary. Duplicates matter because `d1_migrations` keys on the
// number-derived name: two files sharing 0108 would both claim the same entry.
const namesByNumber = new Map<number, string[]>();
for (const name of migrationFiles) {
  const match = name.match(/^(\d{4})_/);
  if (!match) {
    report(
      `migrations/${name}`,
      "MIG-001",
      "file name must start with a 4-digit number followed by _, e.g. 0001_",
    );
    continue;
  }
  const number = Number.parseInt(match[1], 10);
  const existing = namesByNumber.get(number) ?? [];
  existing.push(name);
  namesByNumber.set(number, existing);
}
const numbers = new Set(namesByNumber.keys());
for (const [number, names] of namesByNumber) {
  if (names.length > 1) {
    for (const name of names) {
      report(
        `migrations/${name}`,
        "MIG-001",
        `migration number ${String(number).padStart(4, "0")} is used by ${names.length} files: ${names.join(", ")}`,
      );
    }
  }
}
const maxNumber = Math.max(0, ...numbers);
for (let n = ENFORCED_LOWER_BOUND; n <= maxNumber; n++) {
  if (!numbers.has(n)) {
    report(
      `migrations/`,
      "MIG-001",
      `missing migration number ${String(n).padStart(4, "0")} — contiguity is enforced from ${String(ENFORCED_LOWER_BOUND).padStart(4, "0")} onward, so a gap here means a migration was deleted mid-history`,
    );
  }
}

// Rule MIG-002: frozen names. Every file at or below the boundary must appear
// in the snapshot, and every snapshot entry must exist on disk.
for (const name of migrationFiles) {
  const match = name.match(/^(\d{4})_/);
  if (!match) continue;
  const number = Number.parseInt(match[1], 10);
  if (number > FROZEN_UPPER_BOUND) continue;
  if (!frozenNames.has(name)) {
    report(
      `migrations/${name}`,
      "MIG-002",
      `file numbered ${String(number).padStart(4, "0")} is inside the frozen range but its name is not in scripts/frozen-migration-names.txt — renaming breaks the d1_migrations bookkeeping key`,
    );
  }
}
for (const name of frozenNames) {
  if (!migrationFiles.includes(name)) {
    report(
      `migrations/${name}`,
      "MIG-002",
      "frozen migration file is missing from disk — a rename or deletion inside the frozen range breaks the d1_migrations bookkeeping key",
    );
  }
}

// Rules MIG-003 / MIG-004: naming classifier and rollback block, 0108+ only.
for (const name of migrationFiles) {
  const match = name.match(/^(\d{4})_(.+)\.sql$/);
  if (!match) continue;
  const number = Number.parseInt(match[1], 10);
  if (number <= FROZEN_UPPER_BOUND) continue;
  const rest = match[2];

  const parts = rest.split("_");
  const description = parts.slice(1).join("_");
  if (parts.length < 2 || description.length === 0) {
    report(
      `migrations/${name}`,
      "MIG-003",
      `file name must be NNNN_<type>_<desc>.sql with a non-empty <desc> and <type> in [${ALLOWED_TYPES.join(", ")}]`,
    );
    continue;
  }
  const type = parts[0];
  if (!ALLOWED_TYPES.includes(type)) {
    report(
      `migrations/${name}`,
      "MIG-003",
      `type "${type}" is not in [${ALLOWED_TYPES.join(", ")}]`,
    );
    continue;
  }

  if (TYPES_REQUIRING_ROLLBACK.has(type)) {
    const source = readFileSync(path.join(migrationsRoot, name), "utf8");
    if (!source.includes("-- rollback:")) {
      report(
        `migrations/${name}`,
        "MIG-004",
        `${type} migrations from ${String(ENFORCED_LOWER_BOUND).padStart(4, "0")} onward must contain a "-- rollback:" comment block describing how to undo the change`,
      );
    }
  }
}

finish("migration hygiene");

const frozenOnDisk = migrationFiles.filter((name) =>
  Number.parseInt(name.slice(0, 4), 10) <= FROZEN_UPPER_BOUND,
).length;
const aboveBoundary = maxNumber >= ENFORCED_LOWER_BOUND
  ? `contiguous from ${String(ENFORCED_LOWER_BOUND).padStart(4, "0")} to ${String(maxNumber).padStart(4, "0")}`
  : `nothing above the frozen boundary yet (highest is ${String(maxNumber).padStart(4, "0")})`;
console.log(
  `OK: ${migrationFiles.length} migration files — ` +
  `${frozenOnDisk} frozen (0001–${String(FROZEN_UPPER_BOUND).padStart(4, "0")}, names verified against the snapshot), ` +
  `${aboveBoundary}.`,
);
