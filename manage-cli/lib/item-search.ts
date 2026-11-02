import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {
  ADMIN_TYPEAHEAD_TABLE,
  CREATE_ADMIN_TYPEAHEAD_INDEX_SQL,
  DROP_ADMIN_TYPEAHEAD_INDEX_SQL,
} from "@/shared/ItemSearchSql";
import {ITEM_CONTENT_TEXT_REVISION} from "@/shared/ItemSearch";
import {htmlToPlainText} from "@/shared/StringUtils";
import type {MicrofeedConfig} from "../types";
import type {CloudflareClient} from "./cloudflare";

/** 站点全文搜索索引（site_search 表族）已于迁移 0151 整体退役（ADR-0051）；
 * 本文件只维护后台 typeahead 索引与 items.content_text 列的归一化。 */
const SEARCH_INDEX_TABLES = [ADMIN_TYPEAHEAD_TABLE];

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
        `Item ${row.id} contains invalid saved JSON; content text normalization ` +
          "stopped.",
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

/** 部署路径的判定：后台 typeahead 索引存在才算就绪（site_search 已退役）。 */
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
    DROP_ADMIN_TYPEAHEAD_INDEX_SQL,
    options,
  );
}

/**
 * 把 items.content_text 列归一到当前 revision（正文纯文本，标注引用等
 * 消费方在用，与已退役的全文搜索无关——ADR-0051）。
 */
export async function normalizeItemSearchContent(
  cloudflare: CloudflareClient,
  config: MicrofeedConfig,
  options: ItemSearchOptions = {},
): Promise<number> {
  let normalized = 0;
  // 已知接受项（D1SCAN-001，2026-10-15 本地 9506 行 / 18.4MB 实测 24–41ms）：
  // 谓词含列比列 `content_text_updated_at != updated_at`，任何索引都不可用，
  // 与 `content_text_revision != N` 的 OR 使另一条也走不上索引。仅部署时运行
  // （无陈旧行时 1 轮 + 收尾 COUNT 共约 90ms/部署），接受。
  for (let batch = 0; batch < MAX_NORMALIZATION_BATCHES; batch += 1) {
    const rows = sourceRows(await cloudflare.queryD1(
      config,
      // d1scan:ignore 已知接受项（D1SCAN-001，见上方说明）：谓词含列比列，任何索引不可用；仅部署时运行，9506 行实测 24-41ms。
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
    // d1scan:ignore 收尾核对 COUNT：与上一条同谓词同口径（列比列，索引不可用），仅部署时运行一次，接受。
    "SELECT COUNT(*) AS count FROM items " +
      "WHERE status != 3 AND (content_text_updated_at != updated_at OR " +
      `content_text_revision != ${ITEM_CONTENT_TEXT_REVISION})`,
    options,
  );
  if (!remaining || Number(remaining.count) !== 0) {
    throw new Error(
      "Item content text normalization did not finish. Retry the same " +
        "deployment after item writes have settled.",
    );
  }
  return normalized;
}

export async function prepareItemSearch(
  cloudflare: CloudflareClient,
  config: MicrofeedConfig,
  options: ItemSearchOptions = {},
): Promise<number> {
  await ensureItemSearchIndexes(cloudflare, config, options);
  return normalizeItemSearchContent(cloudflare, config, options);
}

export async function withItemSearchIndexesSuspended<T>(
  cloudflare: CloudflareClient,
  config: MicrofeedConfig,
  operation: () => Promise<T>,
  options: ItemSearchOptions = {},
): Promise<T> {
  // site_search 挂起判定随表族退役（ADR-0051）改为只看 typeahead：整库导入
  // 写 items 时它的触发器仍会逐行重写索引，挂起可省这一段写放大；drop/rebuild
  // 均 IF EXISTS / IF NOT EXISTS，表缺失时安全。
  if (!await searchTablesExist(cloudflare, config, SEARCH_INDEX_TABLES, options)) {
    return operation();
  }
  try {
    await dropItemSearchIndexes(cloudflare, config, options);
  } catch (error) {
    // Best-effort: under the D1 free-tier write quota (code 7500) or other
    // transient write failures we cannot suspend the index. The caller
    // (snapshot export / pull) only needs a read-only copy of the data, so we
    // proceed with the operation unsuspended instead of failing the whole pull.
    console.warn(
      "Skipping typeahead index suspension (write blocked); " +
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
    } catch (error) {
      console.warn(
        "Could not restore the typeahead index after the operation " +
          "(write blocked): " +
          ((error as Error | undefined)?.message ?? String(error)),
      );
    }
  }
}
