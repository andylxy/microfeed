import {readdir, readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {DatabaseSync} from "node:sqlite";

import {describe, expect, it} from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

async function migration(filename: string): Promise<string> {
  return readFile(path.join(repositoryRoot, "migrations", filename), "utf8");
}

/**
 * Apply the entire upstream migration chain (0001..0022) followed by the
 * novel-CMS extension (0023). Replaying the full chain is what proves 0023
 * introduces no naming conflict with any existing upstream table, column, or
 * index — a single `0001 + 0023` pair would hide collisions with tables /
 * columns introduced by 0002..0022.
 */
async function applyUpstreamThenExt(database: DatabaseSync): Promise<void> {
  const dir = path.join(repositoryRoot, "migrations");
  const chain = (await readdir(dir))
    .filter((f) => /^00\d\d_.*\.sql$/.test(f))
    .filter((f) => f <= "0023_ext_novel.sql")
    .sort();
  for (const f of chain) {
    database.exec(await migration(f));
  }
}

describe("0023_ext_novel migration", () => {
  it("creates the ext_* tables and additive columns without conflict on the full upstream chain", async () => {
    const database = new DatabaseSync(":memory:");
    await applyUpstreamThenExt(database);

    const tables = (
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    for (const table of ["ext_category", "ext_content_audit", "ext_content_report"]) {
      expect(tables).toContain(table);
    }
    // exactly the three namespaced tables were added
    expect(tables.filter((t) => t.startsWith("ext_")).sort()).toEqual([
      "ext_category",
      "ext_content_audit",
      "ext_content_report",
    ]);

    // additive columns exist
    const itemCols = (
      database.prepare("PRAGMA table_info(items)").all() as Array<{name: string}>
    ).map((r) => r.name);
    expect(itemCols).toContain("review_status");
    // existing columns untouched (no conflict with upstream schema)
    expect(itemCols).toContain("data");
    expect(itemCols).toContain("pub_date");

    const channelCols = (
      database.prepare("PRAGMA table_info(channels)").all() as Array<{name: string}>
    ).map((r) => r.name);
    expect(channelCols).toContain("genre");
    expect(channelCols).toContain("data");
  });

  it("does not add a redundant updated_at column to ext_category (no scope creep)", async () => {
    const database = new DatabaseSync(":memory:");
    await applyUpstreamThenExt(database);

    const categoryCols = (
      database.prepare("PRAGMA table_info(ext_category)").all() as Array<{name: string}>
    ).map((r) => r.name);
    expect(categoryCols).not.toContain("updated_at");
    // the intentionally kept columns are present
    expect(categoryCols).toEqual(
      expect.arrayContaining(["id", "name", "slug", "created_at"]),
    );
  });

  it("allows inserts into every ext table", async () => {
    const database = new DatabaseSync(":memory:");
    await applyUpstreamThenExt(database);

    database
      .prepare("INSERT INTO ext_category (id, name, slug) VALUES (?, ?, ?)")
      .run("c1", "仙侠", "xianxia");
    database
      .prepare(
        "INSERT INTO ext_content_audit (id, item_id, action, actor_type, diff_data, is_checkpoint) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("a1", "it1", "edit", "author", "[]", 0);
    database
      .prepare("INSERT INTO ext_content_report (id, item_id, status) VALUES (?, ?, ?)")
      .run("r1", "it1", "pending");

    expect(
      (database.prepare("SELECT COUNT(*) AS c FROM ext_category").get() as {c: number}).c,
    ).toBe(1);
    expect(
      (database.prepare("SELECT COUNT(*) AS c FROM ext_content_audit").get() as {c: number}).c,
    ).toBe(1);
    expect(
      (database.prepare("SELECT COUNT(*) AS c FROM ext_content_report").get() as {c: number}).c,
    ).toBe(1);
  });
});
