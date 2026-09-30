/**
 * CLI for the ctwh → microfeed import (spec `.scratch/tcm-import/spec.md` §8).
 *
 * Reads the ctwh MySQL dumps, builds target rows (build.ts), and writes
 * batched SQL files — it never touches a database itself.
 *
 *   node --import tsx scripts/import-ctwh/main.ts            # 小批量（每 kind 20 行）
 *   node --import tsx scripts/import-ctwh/main.ts --limit 5  # 更小的先导批
 *   node --import tsx scripts/import-ctwh/main.ts --full     # 全量（小批量核对全绿后）
 *
 * Output: `<out>/tcm-channels.sql` + `<out>/tcm-batch-NNN.sql` + summary.json.
 * Apply with `wrangler d1 execute ... --file` (local miniflare first; remote
 * only after ticket 07/15 sign-off, and always with proxy env unset).
 */

import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";

import {iterInsertRows, type DumpRow} from "./parse";
import {
  buildTargets,
  htmlToPlain,
  type ImportReport,
  type SourceTables,
  type TargetChannel,
  type TargetItem,
} from "./build";

const DEFAULT_REPO_ROOT = resolve(import.meta.dirname, "../..");
const DEFAULT_SOURCE_DIR = join(DEFAULT_REPO_ROOT, "ctwh");
const DEFAULT_OUT_DIR = join(
  DEFAULT_REPO_ROOT,
  ".scratch/tcm-import/out",
);
const DEFAULT_LIMIT = 20;
/** Statements per batch file — keeps every file well under wrangler's limits. */
const STATEMENTS_PER_BATCH = 300;

const SOURCE_FILES: Array<{file: string; key: keyof SourceTables}> = [
  {file: "WorkInfo.sql", key: "work"},
  {file: "Book.sql", key: "book"},
  {file: "BookBody.sql", key: "bookBody"},
  {file: "Fang.sql", key: "fang"},
  {file: "FangBody.sql", key: "fangBody"},
  {file: "Yao.sql", key: "yao"},
  {file: "yaoAlias.sql", key: "yaoAlias"},
  {file: "MingCi.sql", key: "mingCi"},
];

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlValue(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return sqlString(value);
}

function channelStatement(channel: TargetChannel): string {
  return (
    "INSERT OR REPLACE INTO channels " +
    "(id, status, is_primary, data, created_at, updated_at, genre) VALUES (" +
    [
      sqlString(channel.id),
      String(channel.status),
      "NULL",
      sqlString(JSON.stringify(channel.data)),
      sqlString(channel.createdAt),
      sqlString(channel.createdAt),
      channel.genre ? sqlString(channel.genre) : "NULL",
    ].join(", ") +
    ");"
  );
}

function itemStatement(item: TargetItem): string {
  const timestamp = item.pubDate ?? "2024-01-01T00:00:00.000Z";
  return (
    "INSERT OR REPLACE INTO items " +
    "(id, status, data, pub_date, created_at, updated_at, content_text, " +
    "content_text_updated_at, content_text_revision, review_status, book_id, " +
    "tcm_kind, tcm_parent_id) VALUES (" +
    [
      sqlString(item.id),
      String(item.status),
      sqlString(JSON.stringify(item.data)),
      item.pubDate ? sqlString(item.pubDate) : "NULL",
      sqlString(timestamp),
      sqlString(timestamp),
      sqlString(item.contentText),
      sqlString(timestamp),
      "1",
      "NULL",
      item.bookId ? sqlString(item.bookId) : "NULL",
      sqlString(item.tcmKind),
      item.tcmParentId ? sqlString(item.tcmParentId) : "NULL",
    ].join(", ") +
    ");"
  );
}

function chunk<T>(rows: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    batches.push(rows.slice(i, i + size));
  }
  return batches;
}

function main(): void {
  const sourceDir = resolve(argValue("--src") ?? DEFAULT_SOURCE_DIR);
  const outDir = resolve(argValue("--out") ?? DEFAULT_OUT_DIR);
  const full = hasFlag("--full");
  const limit = full ? null : Number(argValue("--limit") ?? DEFAULT_LIMIT);
  if (limit != null && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error(`--limit 必须是正整数，收到：${String(argValue("--limit"))}`);
  }
  // 单书模式：--book-no <WorkInfo.BookNo>，只导入这一本书（含其篇章/条文/方剂）
  const onlyBookNo = argValue("--book-no");

  const tables: SourceTables = {
    work: [], book: [], bookBody: [], fang: [],
    fangBody: [], yao: [], yaoAlias: [], mingCi: [],
  };
  const sourceCounts: Record<string, number> = {};
  for (const {file, key} of SOURCE_FILES) {
    const text = readFileSync(join(sourceDir, file), "utf8");
    const rows: DumpRow[] = [];
    for (const row of iterInsertRows(text)) {
      rows.push(row);
    }
    tables[key] = rows;
    sourceCounts[key] = rows.length;
  }

  const {channels, items, report} = buildTargets(tables, limit, {onlyBookNo});
  const statements = [
    ...channels.map(channelStatement),
    ...items.map(itemStatement),
  ];

  mkdirSync(outDir, {recursive: true});
  const written: string[] = [];
  if (channels.length > 0) {
    const file = join(outDir, "tcm-channels.sql");
    writeFileSync(file, channels.map(channelStatement).join("\n") + "\n");
    written.push(file);
  }
  chunk(items.map(itemStatement), STATEMENTS_PER_BATCH).forEach(
    (batch, index) => {
      const file = join(outDir, `tcm-batch-${String(index + 1).padStart(3, "0")}.sql`);
      writeFileSync(file, batch.join("\n") + "\n");
      written.push(file);
    },
  );

  const summary = {
    mode: onlyBookNo ? `single-book-${onlyBookNo}` : full ? "full" : `limit-${limit}`,
    sourceCounts,
    report: report as ImportReport,
    outputFiles: written,
    nextStep:
      "先核对 summary（转义/标记/关联/行数），全绿后用 --full 重跑，再按工单 07 导入本地库。",
  };
  const summaryFile = join(outDir, "summary.json");
  writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + "\n");

  const plainItems = items.filter((item) => item.tcmKind === "section").length;
  console.log(
    [
      `模式：${onlyBookNo ? `单书 BookNo=${onlyBookNo}` : full ? "全量" : `小批量 limit=${limit}`}`,
      `频道：${channels.length}`,
      `条目：${JSON.stringify(report.itemsByKind)}`,
      `条文（unlisted）：${plainItems}`,
      `标记：源 ${report.markerCountSource} / 产物 ${report.markerCountOutput}`,
      `残留转义：${report.residualEscapes}`,
      `警告：${report.warnings.length}`,
      `批次文件：${written.length}（+ summary.json）`,
    ].join("\n"),
  );
  for (const warning of report.warnings.slice(0, 10)) {
    console.warn(`WARN ${warning}`);
  }
  if (report.warnings.length > 0 || report.markerCountSource !== report.markerCountOutput) {
    process.exitCode = 1;
  }
}

main();
