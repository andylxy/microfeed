import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {DatabaseSync} from "node:sqlite";

import {describe, expect, it} from "vitest";

import {
  normalizeItemSearchContent,
  rebuildItemSearchIndexes,
  withItemSearchIndexesSuspended,
} from "../../manage-cli/lib/item-search";
import {ADMIN_TYPEAHEAD_TABLE} from "@/shared/ItemSearchSql";
import type {CloudflareClient} from "../../manage-cli/lib/cloudflare";
import type {MicrofeedConfig} from "../../manage-cli/types";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

async function migration(filename: string): Promise<string> {
  return readFile(path.join(repositoryRoot, "migrations", filename), "utf8");
}

function testCloudflare(database: DatabaseSync): CloudflareClient {
  return {
    async executeSqlFile(
      _config: MicrofeedConfig,
      filename: string,
    ): Promise<void> {
      database.exec(await readFile(filename, "utf8"));
    },
    async queryD1(
      _config: MicrofeedConfig,
      sql: string,
    ): Promise<Array<Record<string, unknown>>> {
      return database.prepare(sql).all() as Array<Record<string, unknown>>;
    },
  } as CloudflareClient;
}

const config = {} as MicrofeedConfig;

// 全文搜索表族（site_search_*）随迁移 0151 退役后，这里只保留仍在跑的两件事：
// items.content_text 列的归一化，以及后台 typeahead 索引的挂起与重建。
describe("item content normalization and typeahead index", () => {
  it("reconciles old-writer updates and outdated normalization revisions", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(await migration("0001_initial.sql"));
    database.prepare(
      "INSERT INTO items (id, status, data, updated_at) VALUES (?, 1, ?, ?)",
    ).run(
      "racing-item",
      JSON.stringify({description: "<p>Before</p>", title: "Racing"}),
      "2026-08-01T00:00:00.000Z",
    );
    database.exec(await migration("0009_item_search.sql"));
    database.exec(await migration("0013_pages_search_site_files.sql"));
    database.exec(await migration("0014_default_not_found_page.sql"));
    const cloudflare = testCloudflare(database);
    await normalizeItemSearchContent(cloudflare, config);

    database.prepare(
      "UPDATE items SET data = ?, updated_at = ? WHERE id = ?",
    ).run(
      JSON.stringify({description: "<p>After switch</p>", title: "Racing"}),
      "2026-08-02T00:00:00.000Z",
      "racing-item",
    );
    expect(await normalizeItemSearchContent(cloudflare, config)).toBe(1);
    expect(database.prepare(
      "SELECT content_text FROM items WHERE id = 'racing-item'",
    ).get()).toEqual({content_text: "After switch"});

    database.prepare(
      "UPDATE items SET content_text = 'old algorithm', " +
        "content_text_revision = 0 WHERE id = 'racing-item'",
    ).run();
    expect(await normalizeItemSearchContent(cloudflare, config)).toBe(1);
    expect(database.prepare(
      "SELECT content_text, content_text_revision FROM items " +
        "WHERE id = 'racing-item'",
    ).get()).toEqual({content_text: "After switch", content_text_revision: 1});
  });

  it("drops the typeahead index for an export and rebuilds it afterwards", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(await migration("0001_initial.sql"));
    database.prepare(
      "INSERT INTO items (id, status, data, updated_at) VALUES (?, 1, ?, ?)",
    ).run(
      "typeahead-item",
      JSON.stringify({title: "黄芪 overview"}),
      "2026-08-01T00:00:00.000Z",
    );
    database.exec(await migration("0009_item_search.sql"));
    database.exec(await migration("0013_pages_search_site_files.sql"));
    database.exec(await migration("0014_default_not_found_page.sql"));
    const cloudflare = testCloudflare(database);
    await rebuildItemSearchIndexes(cloudflare, config);

    const countRows = () => database.prepare(
      "SELECT COUNT(*) AS count FROM " +
        `${ADMIN_TYPEAHEAD_TABLE} WHERE content_id = 'typeahead-item'`,
    ).get() as {count: number};
    expect(countRows()).toEqual({count: 1});

    // 挂起期间索引表整张被 DROP（连带 5 张 FTS5 影子表），所以断言只能查
    // sqlite_schema：对被删掉的表发 SELECT 报的是 no such table，不是 0 行。
    const countIndexObjects = () => database.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_schema " +
        "WHERE type = 'table' AND name LIKE 'ext_admin_typeahead%'",
    ).get() as {count: number};
    expect(countIndexObjects()).toEqual({count: 6});

    const suspended = await withItemSearchIndexesSuspended(
      cloudflare,
      config,
      async () => countIndexObjects(),
    );
    expect(suspended).toEqual({count: 0});
    expect(countIndexObjects()).toEqual({count: 6});
    expect(countRows()).toEqual({count: 1});
  });
});
