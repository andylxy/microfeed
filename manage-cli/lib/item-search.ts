import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {
  ADMIN_TYPEAHEAD_TABLE,
  CREATE_ADMIN_TYPEAHEAD_INDEX_SQL,
  CREATE_ITEM_SEARCH_INDEX_SQL,
  DROP_ADMIN_TYPEAHEAD_INDEX_SQL,
  DROP_ITEM_SEARCH_INDEX_SQL,
  SITE_SEARCH_VIRTUAL_TABLE_PREFIXES,
} from "@/shared/ItemSearchSql";
import {ITEM_CONTENT_TEXT_REVISION} from "@/shared/ItemSearch";
import {htmlToPlainText} from "@/shared/StringUtils";
import type {MicrofeedConfig} from "../types";
import type {CloudflareClient} from "./cloudflare";

/** 一并由本文件维护的派生索引表：两份站点搜索虚拟表 + 后台 typeahead 索引。 */
const SEARCH_INDEX_TABLES = [
  ...SITE_SEARCH_VIRTUAL_TABLE_PREFIXES,
  ADMIN_TYPEAHEAD_TABLE,
];

const NORMALIZATION_BATCH_SIZE = 50;
const MAX_NORMALIZATION_BATCHES = 10_000;

interface ItemSearchOptions {
  local?: boolean;
  persistTo?: string;
}

interface ItemSearchSourceRow extends Record<string, unknown> {
  data: string;
  id: string;
  updated_at: string;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function executeTemporarySql(
  cloudflare: CloudflareClient,
  config: MicrofeedConfig,
  sql: string,
  options: ItemSearchOptions,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "microfeed-item-search-"));
  try {
    const filename = path.join(directory, "item-search.sql");
    await writeFile(filename, `${sql.trim()}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await cloudflare.executeSqlFile(config, filename, options);
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
}

function sourceRows(
  rows: Array<Record<string, unknown>>,
): ItemSearchSourceRow[] {
  return rows.map((row) => {
    if (
      typeof row.id !== "string" ||
      typeof row.data !== "string" ||
      typeof row.updated_at !== "string"
    ) {
      throw new Error("D1 returned an invalid item search normalization row.");
    }
    return row as ItemSearchSourceRow;
  });
}

function normalizedUpdateSql(rows: readonly ItemSearchSourceRow[]): string {
  return rows.map((row) => {
    let data: unknown;
    try {
      data = JSON.parse(row.data);
    } catch {
      throw new Error(
        `Item ${row.id} contains invalid saved JSON; search normalization ` +
          "stopped without marking the index ready.",
      );
    }
    const description = data && typeof data === "object" &&
        typeof (data as {description?: unknown}).description === "string"
      ? (data as {description: string}).description
      : "";
    const contentText = htmlToPlainText(description);
    return "UPDATE items SET " +
      `content_text = ${sqlString(contentText)}, ` +
      `content_text_revision = ${ITEM_CONTENT_TEXT_REVISION}, ` +
      `content_text_updated_at = ${sqlString(row.updated_at)} ` +
      `WHERE id = ${sqlString(row.id)} AND ` +
      `updated_at = ${sqlString(row.updated_at)};`;
  }).join("\n");
}

export async function rebuildItemSearchIndexes(
  cloudflare: CloudflareClient,
  config: MicrofeedConfig,
  options: ItemSearchOptions = {},
): Promise<void> {
  await executeTemporarySql(
    cloudflare,
    config,
    `${DROP_ITEM_SEARCH_INDEX_SQL}\n${CREATE_ITEM_SEARCH_INDEX_SQL}\n` +
      `${DROP_ADMIN_TYPEAHEAD_INDEX_SQL}\n${CREATE_ADMIN_TYPEAHEAD_INDEX_SQL}`,
    options,
  );
}

async function searchTablesExist(
  cloudflare: CloudflareClient,
  config: MicrofeedConfig,
  tableNames: readonly string[],
  options: ItemSearchOptions,
): Promise<boolean> {
  const rows = await cloudflare.queryD1(
    config,
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN " +
      `(${tableNames.map((name) => `'${name}'`).join(", ")}) ORDER BY name`,
    options,
  );
  return rows.length === tableNames.length;
}

/** 部署路径的完整判定：站点搜索虚拟表 + 后台 typeahead 索引三张全部存在才算就绪。 */
export async function itemSearchIndexesExist(
  cloudflare: CloudflareClient,
  config: MicrofeedConfig,
  options: ItemSearchOptions = {},
): Promise<boolean> {
  return searchTablesExist(cloudflare, config, SEARCH_INDEX_TABLES, options);
}

export async function ensureItemSearchIndexes(
  cloudflare: CloudflareClient,
  config: MicrofeedConfig,
  options: ItemSearchOptions = {},
): Promise<void> {
  if (!await itemSearchIndexesExist(cloudflare, config, options)) {
    await rebuildItemSearchIndexes(cloudflare, config, options);
  }
}

export async function dropItemSearchIndexes(
  cloudflare: CloudflareClient,
  config: MicrofeedConfig,
  options: ItemSearchOptions = {},
): Promise<void> {
  await executeTemporarySql(
    cloudflare,
    config,
    `${DROP_ITEM_SEARCH_INDEX_SQL}\n${DROP_ADMIN_TYPEAHEAD_INDEX_SQL}`,
    options,
  );
}

export async function normalizeItemSearchContent(
  cloudflare: CloudflareClient,
  config: MicrofeedConfig,
  options: ItemSearchOptions = {},
  markReady = true,
): Promise<number> {
  await cloudflare.queryD1(
    config,
    "UPDATE site_search_metadata SET ready = 0, normalized_at = NULL " +
      "WHERE id = 1",
    options,
  );

  let normalized = 0;
  // 已知接受项（D1SCAN-001，2026-10-15 本地 9506 行 / 18.4MB 实测 24–41ms）：
  // 谓词含列比列 `content_text_updated_at != updated_at`，任何索引都不可用，
  // 与 `content_text_revision != N` 的 OR 使另一条也走不上索引。仅部署重建
  // 搜索索引时运行（无陈旧行时 1 轮 + 收尾 COUNT 共约 90ms/部署），接受；
  // 若要根治须改维护 stale 标记位，不属于索引方案。
  for (let batch = 0; batch < MAX_NORMALIZATION_BATCHES; batch += 1) {
    const rows = sourceRows(await cloudflare.queryD1(
      config,
      "SELECT id, data, updated_at FROM items " +
        "WHERE status != 3 AND (content_text_updated_at != updated_at OR " +
        `content_text_revision != ${ITEM_CONTENT_TEXT_REVISION}) ` +
        `ORDER BY rowid LIMIT ${NORMALIZATION_BATCH_SIZE}`,
      options,
    ));
    if (rows.length === 0) break;
    await executeTemporarySql(
      cloudflare,
      config,
      normalizedUpdateSql(rows),
      options,
    );
    normalized += rows.length;
  }

  const [remaining] = await cloudflare.queryD1(
    config,
    "SELECT COUNT(*) AS count FROM items " +
      "WHERE status != 3 AND (content_text_updated_at != updated_at OR " +
      `content_text_revision != ${ITEM_CONTENT_TEXT_REVISION})`,
    options,
  );
  if (!remaining || Number(remaining.count) !== 0) {
    throw new Error(
      "Item search normalization did not finish. Retry the same deployment " +
        "after item writes have settled.",
    );
  }
  if (markReady) {
    const normalizedAt = new Date().toISOString();
    await cloudflare.queryD1(
      config,
      "INSERT INTO site_search_metadata (id, ready, normalized_at) VALUES " +
        `(1, 1, ${sqlString(normalizedAt)}) ON CONFLICT(id) DO UPDATE SET ` +
        "ready = 1, normalized_at = excluded.normalized_at",
      options,
    );
  }
  return normalized;
}

export async function setItemSearchReady(
  cloudflare: CloudflareClient,
  config: MicrofeedConfig,
  ready: boolean,
  options: ItemSearchOptions = {},
): Promise<void> {
  await cloudflare.queryD1(
    config,
    "UPDATE site_search_metadata SET " +
      `ready = ${ready ? 1 : 0}, ` +
      `${ready ? "normalized_at = CURRENT_TIMESTAMP" : "normalized_at = NULL"} ` +
      "WHERE id = 1",
    options,
  );
}

export async function prepareItemSearch(
  cloudflare: CloudflareClient,
  config: MicrofeedConfig,
  options: ItemSearchOptions = {},
  markReady = true,
): Promise<number> {
  await ensureItemSearchIndexes(cloudflare, config, options);
  return normalizeItemSearchContent(cloudflare, config, options, markReady);
}

export async function withItemSearchIndexesSuspended<T>(
  cloudflare: CloudflareClient,
  config: MicrofeedConfig,
  operation: () => Promise<T>,
  options: ItemSearchOptions = {},
): Promise<T> {
  // 挂起判定只看站点搜索的 FTS 虚拟表：它们才是整库覆盖时写 amplification 的来源。
  // ext_admin_typeahead 由部署时的 CREATE_ADMIN_TYPEAHEAD_INDEX_SQL 单独创建，不在任何
  // 迁移里，纯迁移建出来的库（快照 released-head 升级路径）根本没有它，若把它计入判定
  // 会让挂起被整体跳过，导出就会带着 FTS 触发器海量重写。drop/rebuild 都用 IF EXISTS /
  // IF NOT EXISTS，typeahead 缺失时一并走一遍也安全。
  if (!await searchTablesExist(
    cloudflare,
    config,
    SITE_SEARCH_VIRTUAL_TABLE_PREFIXES,
    options,
  )) {
    return operation();
  }
  try {
    await dropItemSearchIndexes(cloudflare, config, options);
  } catch (error) {
    // Best-effort: under the D1 free-tier write quota (code 7500) or other
    // transient write failures we cannot suspend the FTS indexes. The caller
    // (snapshot export / pull) only needs a read-only copy of the data, so we
    // proceed with the operation unsuspended instead of failing the whole pull.
    console.warn(
      "Skipping item search index suspension (write blocked); " +
        "continuing with the operation: " +
        ((error as Error | undefined)?.message ?? String(error)),
    );
    return operation();
  }
  try {
    return await operation();
  } finally {
    try {
      await rebuildItemSearchIndexes(cloudflare, config, options);
      await normalizeItemSearchContent(cloudflare, config, options);
    } catch (error) {
      console.warn(
        "Could not restore item search indexes after the operation " +
          "(write blocked): " +
          ((error as Error | undefined)?.message ?? String(error)),
      );
    }
  }
}
