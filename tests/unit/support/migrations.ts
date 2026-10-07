import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";

/**
 * Shared access to the SQL migration directory, for the tests that read the
 * migrations as their source of truth (`admin-page-guards` and
 * `admin-endpoint-guards`).
 *
 * Every such test replays the files in filename order, so the enumeration lives
 * here once: a test that ordered them differently would be comparing against a
 * different database state, and the two would silently disagree.
 */
export const MIGRATIONS = "migrations";

/** Every migration file name, oldest first. */
export function migrationNames(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/** The SQL text of one migration, by file name. */
export function readMigration(name: string): string {
  return readFileSync(join(MIGRATIONS, name), "utf8");
}
