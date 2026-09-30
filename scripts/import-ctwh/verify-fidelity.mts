// 全量保真审计（工单 07/16 复用）：
// 重新解码源 dump → 期望行；从本地 D1 sqlite 直接读回实际行 → 逐字段 diff。
// 覆盖：title / description(逐字节) / status / book_id / tcm_parent_id /
// pub_date / content_text / 频道 data 与 genre。
// 运行：node --import tsx scripts/import-ctwh/verify-fidelity.mts [--instance name]
//
// 为什么直接读 sqlite：沙箱内从 node(tsx) 再 spawn node/wrangler 会 EBUSY，
// 而 miniflare 的本地 D1 就是一个普通 sqlite 文件（node:sqlite 内置可读）。
// 远程验证（工单 16）改由 Bash 跑 wrangler --json 落盘后对照本脚本逻辑。
import {readdirSync, readFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";

import {iterInsertRows, type DumpRow} from "./parse";
import {buildTargets, type SourceTables} from "./build";

const root = resolve(import.meta.dirname, "../..");
const sourceDir = join(root, "ctwh");
const instance = process.argv.includes("--instance")
  ? process.argv[process.argv.indexOf("--instance") + 1]
  : "ctwh-881019-xyz";

const d1Dir = join(
  root,
  `.microfeed/instances/${instance}/.wrangler/state/v3/d1/miniflare-D1DatabaseObject`,
);
const dbFile = readdirSync(d1Dir).find(
  (file) => file.endsWith(".sqlite") && file !== "metadata.sqlite",
);
if (!dbFile) {
  throw new Error(`未找到本地 D1 sqlite：${d1Dir}`);
}
const db = new DatabaseSync(join(d1Dir, dbFile));

function d1Rows(sql: string): Array<Record<string, unknown>> {
  return db.prepare(sql).all() as Array<Record<string, unknown>>;
}

// ---- 期望：重新解码源 dump（与导入同一构建逻辑） -------------------------
const files: Array<[string, keyof SourceTables]> = [
  ["WorkInfo.sql", "work"],
  ["Book.sql", "book"],
  ["BookBody.sql", "bookBody"],
  ["Fang.sql", "fang"],
  ["FangBody.sql", "fangBody"],
  ["Yao.sql", "yao"],
  ["yaoAlias.sql", "yaoAlias"],
  ["MingCi.sql", "mingCi"],
];
const tables: SourceTables = {
  work: [], book: [], bookBody: [], fang: [],
  fangBody: [], yao: [], yaoAlias: [], mingCi: [],
};
for (const [file, key] of files) {
  tables[key] = [...iterInsertRows(readFileSync(join(sourceDir, file), "utf8"))] as DumpRow[];
}
const {channels: expectedChannels, items: expectedItems} = buildTargets(tables, null);

// ---- 实际：从 D1 读回 ----------------------------------------------------
const kinds = ["chapter", "section", "fang", "yao", "term"];
const actual = new Map<string, Record<string, unknown>>();
for (const kind of kinds) {
  const rows = d1Rows(
    `SELECT id, status, data, pub_date, content_text, book_id, tcm_kind, tcm_parent_id ` +
    `FROM items WHERE tcm_kind='${kind}'`,
  );
  for (const row of rows) actual.set(String(row.id), row);
}
const actualChannels = new Map<string, Record<string, unknown>>();
for (const row of d1Rows(
  `SELECT id, status, data, genre FROM channels ` +
  `WHERE id IN (${expectedChannels.map((c) => `'${c.id}'`).join(",")})`,
)) {
  actualChannels.set(String(row.id), row);
}

// ---- 逐字段 diff ----------------------------------------------------------
let checked = 0;
const mismatches: string[] = [];
function eq(field: string, id: string, expectedV: unknown, actualV: unknown): void {
  checked += 1;
  const a = JSON.stringify(actualV ?? null);
  const b = JSON.stringify(expectedV ?? null);
  if (a !== b) {
    mismatches.push(`${field} @ ${id}: 期望 ${b.slice(0, 120)} 实际 ${a.slice(0, 120)}`);
  }
}

for (const item of expectedItems) {
  const row = actual.get(item.id);
  if (!row) {
    mismatches.push(`缺失条目 ${item.tcmKind}:${item.id}`);
    continue;
  }
  const data = JSON.parse(String(row.data ?? "{}")) as Record<string, unknown>;
  eq("title", item.id, item.data.title, data.title);
  eq("description", item.id, item.data.description, data.description);
  eq("_microfeed", item.id, item.data._microfeed, data._microfeed);
  eq("content_format", item.id, item.data.content_format, data.content_format);
  eq("status", item.id, item.status, Number(row.status));
  eq("book_id", item.id, item.bookId, row.book_id);
  eq("tcm_parent_id", item.id, item.tcmParentId, row.tcm_parent_id);
  eq("pub_date", item.id, item.pubDate, row.pub_date ? String(row.pub_date) : null);
  eq("content_text", item.id, item.contentText, row.content_text === null ? null : String(row.content_text));
}

for (const channel of expectedChannels) {
  const row = actualChannels.get(channel.id);
  if (!row) {
    mismatches.push(`缺失频道 ${channel.id}`);
    continue;
  }
  const data = JSON.parse(String(row.data ?? "{}")) as Record<string, unknown>;
  eq("channel.title", channel.id, channel.data.title, data.title);
  eq("channel.description", channel.id, channel.data.description, data.description);
  eq("channel._microfeed", channel.id, channel.data._microfeed, data._microfeed);
  eq("channel.genre", channel.id, channel.genre, row.genre);
  eq("channel.status", channel.id, channel.status, Number(row.status));
}

// 孤儿与多余额外交核
const expectedIds = new Set(expectedItems.map((i) => i.id));
let extraTcmItems = 0;
for (const [id] of actual) {
  if (!expectedIds.has(id)) extraTcmItems += 1;
}

console.log(JSON.stringify({
  比对字段数: checked,
  期望条目: expectedItems.length,
  实际条目: actual.size,
  期望频道: expectedChannels.length,
  多出的中医条目: extraTcmItems,
  不一致: mismatches.length,
  明细: mismatches.slice(0, 10),
}, null, 2));
if (mismatches.length > 0 || extraTcmItems > 0) process.exitCode = 1;
