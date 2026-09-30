// 名词库（term）定向导入工具 —— 把 ctwh/MingCi.sql 的名词条目导入并归属到「名词」书频道。
//
// 设计要点（照 import-yao.mjs 模式）：
//   - 复用 build.ts 的精确 MingCi→term 映射（tcmId("term",MingCiId) 确定性 11 位 id、转义还原、
//     代理字符清洗、title=MingCiName 原样不 trim、mingCiList/no/beiMing/type/sourceImagePath 入口袋）。
//   - 建「名词」书频道：本地无此频道（远端是容器 tcmterm0001）。按技能 §4.8「平铺型 TCM 书 = 普通书频道」
//     与本地既有「中药」书（4KbG9bDqdz3，genre=本草、无 tcmContainer 标记）保持一致，建**普通书**，
//     genre=本草（gsY3ELgQsE4），不带 tcmContainer 标记 —— 这样它出现在书选择器 / 卷面板 / 书页，
//     编辑页「归属书本」显示「名词」而非原始 id（错误区 1 不会复发）。
//   - 关联卷：名词是平铺集合、无篇章层级；照中药做法建一个确定性根 chapter（= 卷，title「名词」），
//     全部 term 经 tcm_parent_id 挂到它下，卷面板即以「名词」为一卷。term 的 tcm_kind 仍为 'term'，
//     不污染 App 条文视图（reads.ts getAppChapterContent 按 tcm_kind='section' 过滤）。
//
// 用法：
//   node --import tsx scripts/import-ctwh/import-term.mjs [--apply] [--src ctwh] [--out ctwh-books/term/out]
//   --apply  实际写入本地 D1（默认只构建 + 校验，不落库）

import {readFileSync, writeFileSync, mkdirSync, readdirSync} from "node:fs";
import {join, resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {iterInsertRows, rowValue} from "./parse.ts";
import {buildTargets, tcmId} from "./build.ts";

const TARGET_BOOK_ID = "tcmterm0001"; // 名词书频道（本地新建；与 build.ts 容器 id 同名，但按本地惯例作普通书）
const BOOK_TITLE = "名词";
const BOOK_GENRE = "gsY3ELgQsE4"; // 本草（与「中药」书同分类）
const TERM_CHAPTER_ID = tcmId("chapter", TARGET_BOOK_ID); // 根 chapter（卷）
const INSTANCE = "ctwh-881019-xyz";
const NOW = new Date().toISOString().slice(0, 19).replace("T", " ");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const SRC = resolve(args.includes("--src") ? args[args.indexOf("--src") + 1] : "ctwh");
const OUT = resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : "ctwh-books/term/out");

function localDbHandle() {
  const d1Dir = join(".microfeed/instances", INSTANCE, "local-state", "v3/d1/miniflare-D1DatabaseObject");
  const dbFile = readdirSync(d1Dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  if (!dbFile) throw new Error(`未找到本地 D1 sqlite：${d1Dir}`);
  return new DatabaseSync(join(d1Dir, dbFile));
}

const sqlStr = (v) => `'${String(v).replace(/'/g, "''")}'`;

// ---- 1) 读源并复用 build.ts 全量映射，仅取 term ----
const tables = {
  work: [...iterInsertRows(readFileSync(join(SRC, "WorkInfo.sql"), "utf8"))],
  book: [...iterInsertRows(readFileSync(join(SRC, "Book.sql"), "utf8"))],
  bookBody: [...iterInsertRows(readFileSync(join(SRC, "BookBody.sql"), "utf8"))],
  fang: [...iterInsertRows(readFileSync(join(SRC, "Fang.sql"), "utf8"))],
  fangBody: [...iterInsertRows(readFileSync(join(SRC, "FangBody.sql"), "utf8"))],
  yao: [...iterInsertRows(readFileSync(join(SRC, "Yao.sql"), "utf8"))],
  yaoAlias: [...iterInsertRows(readFileSync(join(SRC, "yaoAlias.sql"), "utf8"))],
  mingCi: [...iterInsertRows(readFileSync(join(SRC, "MingCi.sql"), "utf8"))],
};
const {items, report} = buildTargets(tables, null, {}); // 全量：含全部 term（book_id=tcmterm0001）
const termItems = items.filter((it) => it.tcmKind === "term");

// ---- 2) 归属 + 挂根 chapter + volume 标签 ----
const finalTerms = termItems.map((it) => {
  const data = JSON.parse(JSON.stringify(it.data));
  data._microfeed = {...(data._microfeed ?? {}), bookId: TARGET_BOOK_ID, volume: BOOK_TITLE};
  return {...it, bookId: TARGET_BOOK_ID, tcmParentId: TERM_CHAPTER_ID, data};
});

// 根 chapter（卷）
const termChapter = {
  id: TERM_CHAPTER_ID,
  status: 1,
  bookId: TARGET_BOOK_ID,
  tcmKind: "chapter",
  tcmParentId: null,
  pubDate: "2024-01-01T00:00:00.000Z",
  data: {title: BOOK_TITLE, description: "", content_format: "html", _microfeed: {bookId: TARGET_BOOK_ID, section: 1}},
  contentText: "",
};

// 名词书频道（普通书）
const bookChannel = {
  id: TARGET_BOOK_ID,
  status: 1,
  genre: BOOK_GENRE,
  data: {title: BOOK_TITLE, description: "中医名词解释", _microfeed: {}},
  createdAt: NOW,
};

// ---- 3) 安全校验 ----
const warnings = [];
let localDb = null;
try { localDb = localDbHandle(); } catch (e) { warnings.push("无法打开本地 D1 用于校验：" + e.message); }
if (localDb) {
  const exists = localDb.prepare("SELECT id, status, genre, json_extract(data,'$._microfeed.tcmContainer') tc, json_extract(data,'$.title') t FROM channels WHERE id=?").get(TARGET_BOOK_ID);
  if (exists) {
    warnings.push(`频道 ${TARGET_BOOK_ID} 已存在（t=${exists.t}, status=${exists.status}, tc=${exists.tc}）—— INSERT OR REPLACE 会覆盖为「名词」普通书`);
  } else {
    console.log(`频道 ${TARGET_BOOK_ID} 不存在，将新建「名词」普通书频道`);
  }
  const existing = localDb.prepare("SELECT id, json_extract(data,'$.title') t FROM items WHERE tcm_kind='term'").all();
  if (existing.length) warnings.push(`本地已有 ${existing.length} 条 term（重导原地替换）`);
  const srcIds = new Set(tables.mingCi.map((r) => tcmId("term", String(rowValue(r, "MingCiId") ?? ""))));
  const orphan = existing.filter((r) => !srcIds.has(r.id));
  if (orphan.length) warnings.push(`本地 ${orphan.length} 条 term 的 id 不在源推导集内（重导后成孤儿）`);
}

// ---- 4) 残留转义复核 ----
let residualEscapes = 0;
for (const it of finalTerms) {
  for (const t of [String(it.data.description ?? ""), String(it.data.title ?? ""), it.contentText]) {
    if (/\\+[nrt'"\\]/.test(t)) residualEscapes += 1;
  }
}

// ---- 5) 写 SQL 产物 ----
mkdirSync(OUT, {recursive: true});
const channelStatement = (c) =>
  "INSERT OR REPLACE INTO channels (id, status, is_primary, data, created_at, updated_at, genre) VALUES (" +
  [sqlStr(c.id), String(c.status), "NULL", sqlStr(JSON.stringify(c.data)), sqlStr(c.createdAt), sqlStr(c.createdAt),
    c.genre ? sqlStr(c.genre) : "NULL"].join(", ") + ");";
const itemStatement = (item) => {
  const ts = item.pubDate ?? "2024-01-01T00:00:00.000Z";
  return "INSERT OR REPLACE INTO items " +
    "(id, status, data, pub_date, created_at, updated_at, content_text, content_text_updated_at, " +
    "content_text_revision, review_status, book_id, tcm_kind, tcm_parent_id) VALUES (" +
    [sqlStr(item.id), String(item.status), sqlStr(JSON.stringify(item.data)),
      item.pubDate ? sqlStr(item.pubDate) : "NULL", sqlStr(ts), sqlStr(ts), sqlStr(item.contentText), sqlStr(ts),
      "1", "NULL", item.bookId ? sqlStr(item.bookId) : "NULL", sqlStr(item.tcmKind),
      item.tcmParentId ? sqlStr(item.tcmParentId) : "NULL"].join(", ") + ");";
};
const ordered = [termChapter, ...finalTerms]; // 根 chapter 在前
const batches = [];
for (let i = 0; i < ordered.length; i += 300) batches.push(ordered.slice(i, i + 300).map(itemStatement));
writeFileSync(join(OUT, "tcm-channels.sql"), channelStatement(bookChannel) + "\n");
batches.forEach((b, i) => writeFileSync(join(OUT, `tcm-batch-${String(i + 1).padStart(3, "0")}.sql`), b.join("\n") + "\n"));

const summary = {
  targetBookId: TARGET_BOOK_ID, rootChapterId: TERM_CHAPTER_ID, mode: APPLY ? "build+apply" : "build-only",
  termCount: finalTerms.length, sourceMingCiRows: tables.mingCi.length,
  buildReportMarkers: `${report.markerCountSource}/${report.markerCountOutput}`,
  buildReportResidualEscapes: report.residualEscapes, termSubsetResidualEscapes: residualEscapes,
  batches: batches.length, warnings, outputDir: OUT,
};
writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2) + "\n");

console.log("=== term 导入构建结果 ===");
console.log("目标书：", TARGET_BOOK_ID, "（名词） 根 chapter：", TERM_CHAPTER_ID);
console.log("term 条目数：", finalTerms.length, "（源 MingCi.sql", tables.mingCi.length, "行）");
console.log("build 标记 源/产物：", summary.buildReportMarkers, " 残留转义：", report.residualEscapes, " term 子集：", residualEscapes);
console.log("样例：", finalTerms.slice(0, 3).map((t) => JSON.stringify(t.data.title)).join(", "));
if (warnings.length) { console.warn("警告："); for (const w of warnings) console.warn("  - " + w); }

// ---- 6) 应用 ----
if (APPLY) {
  const db = localDbHandle();
  db.exec("PRAGMA recursive_triggers=ON;");
  db.exec("BEGIN;");
  try {
    db.exec(channelStatement(bookChannel));
    for (const b of batches) for (const stmt of b) db.exec(stmt);
    db.exec("COMMIT;");
  } catch (e) {
    db.exec("ROLLBACK;");
    console.error("APPLY FAILED:", e.message);
    process.exit(2);
  }
  const c = db.prepare("SELECT COUNT(*) c FROM items WHERE tcm_kind='term'").get();
  const reparented = db.prepare("SELECT COUNT(*) c FROM items WHERE tcm_kind='term' AND tcm_parent_id=?").get(TERM_CHAPTER_ID);
  const book = db.prepare("SELECT id, status, genre, json_extract(data,'$.title') t FROM channels WHERE id=?").get(TARGET_BOOK_ID);
  console.log("应用完成：term 现 =", c.c, " 已挂根 chapter =", reparented.c, "/", c.c);
  console.log("名词频道：", JSON.stringify(book));
  const sample = db.prepare("SELECT id, json_extract(data,'$.title') t, json_extract(data,'$._microfeed.no') no FROM items WHERE tcm_kind='term' ORDER BY json_extract(data,'$._microfeed.no') LIMIT 5").all();
  console.log("按 no 排序前 5：", JSON.stringify(sample));
}
