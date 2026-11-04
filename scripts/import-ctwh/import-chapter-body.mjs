// 书本卷章正文（book_chapter_body）导入工具 —— 把 ctwh/BookChapterBody.sql 的
// 8066 行正文导入本地 D1。
//
// 设计要点（照 import-term.mjs / import-yao.mjs 模式）：
//   - 复用 parse.ts 的 iterInsertRows/mysqlUnescape：dump 里的 `\r` `\n` `\t` `\'`
//     全部还原成真实控制字符。**全格式保真**（ADR-0062 决策 6）——不 trim、不 strip、
//     不归一换行、不折叠空白。正文的前导缩进、句号后空格、真实换行、字面 CR 都是内容。
//   - 写入走**参数化语句**（db.prepare(...).run(...)），不拼 SQL 字符串：文本原样进库、
//     不生成 SQL 文件、不触发 `git diff --check` 的尾随空白红线。
//   - **全量导入 8066 行**（930 本草 + 7136 经典）。严禁按 IsEnable 过滤——只导启用
//     会丢 7136 行经典正文。
//   - 卷章关联：源 BookChapterBody.BookChapterId 是源 BookChapter.Id，经本地
//     `book_chapter.source_chapter_legacy_id` 映射到新 id（0182 种子带该列）。
//   - 本草派生列：`bencao_yao_name` = BieMing 首逗号段、`bencao_level` = 源 Extend01。
//     只存档、**不回写 zhong_yao**（ADR-0062 决策 3）。
//
// 自检（任一不符 fail-fast，`--apply` 时中止）：
//   行数 8066 / 关联 0 悬空 / 标记计数 / 本草派生 / 格式保真 LF·CR·缩进·句号后空格。
//
// 用法：
//   node --import tsx scripts/import-ctwh/import-chapter-body.mjs [--apply] [--src ctwh]
//   --apply  实际写入本地 D1（默认只构建 + 自检，不写库）

import {readFileSync, readdirSync, writeFileSync, mkdirSync} from "node:fs";
import {join, resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {iterInsertRows, rowValue} from "./parse.ts";

const INSTANCE = "ctwh-881019-xyz";
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const SRC = resolve(args.includes("--src") ? args[args.indexOf("--src") + 1] : "ctwh");
const OUT = resolve(
  args.includes("--out") ? args[args.indexOf("--out") + 1] : "ctwh-books/chapter-body/out",
);

/** 源数据基线（2026-11-04 审计实测，ADR-0062 数据审计节）。 */
const EXPECTED = {
  rows: 8066,
  bencaoRows: 930,
  bencaoYaoNames: 704,
  bencaoLevelMain: 545, // Extend01='0'
  bencaoLevelAlt: 385, // Extend01='1'
  fangJiNullAfterNormalize: 6727, // 空串 4435 + NULL 2292
  markers: {"$a{": 265, "$m{": 34, "$n{": 36, "$x{": 49, "$r{": 0},
  // 格式保真基线
  lfSectionText: 392,
  lfSectionNote: 1214,
  crSectionTextRows: 4,
  crSectionTextChars: 19,
  indentSectionText: 37,
  indentSectionNote: 1026,
  // 行尾空格行数（源数据用「句号后 1–2 个空格 + 换行」作换行标记，故行尾带空格）。
  // 实测口径 = `col != RTRIM(col)`，SectionText 451 / SectionNote 549。
  trailSpaceSectionText: 451,
  trailSpaceSectionNote: 549,
  // 源 SectionText 8066/8066 非空（空串 0、NULL 0）；SectionNote 空 6638 属正常
  emptySectionText: 0,
};

/**
 * 打开活跃的本地 D1。
 *
 * miniflare 的 D1 目录下可能并存多个 `*.sqlite`（旧实例遗留）。`readdirSync`
 * 顺序不确定，取第一个会打到废弃库上（实测存在 176 迁移/18 items 的旧库与
 * 178 迁移/9506 items 的活跃库并存）。这里按 `d1_migrations` 记录数取最新那个。
 */
function localDbHandle() {
  const d1Dir = join(
    ".microfeed/instances",
    INSTANCE,
    "local-state",
    "v3/d1/miniflare-D1DatabaseObject",
  );
  const candidates = readdirSync(d1Dir).filter(
    (f) => f.endsWith(".sqlite") && f !== "metadata.sqlite",
  );
  if (candidates.length === 0) throw new Error(`未找到本地 D1 sqlite：${d1Dir}`);

  let best = null;
  for (const file of candidates) {
    const handle = new DatabaseSync(join(d1Dir, file));
    let applied = -1;
    try {
      applied = handle.prepare("SELECT COUNT(*) AS c FROM d1_migrations").get().c;
    } catch {
      applied = -1; // 无账本表的库是废弃/空库
    }
    if (!best || applied > best.applied) best = {applied, handle};
    else handle.close();
  }
  if (!best || best.applied < 0) throw new Error(`本地 D1 无迁移账本：${d1Dir}`);
  console.log("本地 D1：", best.applied, "条已应用迁移");
  return best.handle;
}

function randomShortUUID(length = 11) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
  let out = "";
  for (let i = 0; i < length; i += 1) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

const asText = (v) => (v == null ? "" : String(v));

/** 文本字段原样返回；空串保持空串（不 trim）。 */
const rawText = (v) => (v == null ? null : String(v));

/** 可空文本：NULL 与空串 → NULL（仅用于 FangJi 的 `''→NULL` 归一，不改非空值）。 */
const nullIfEmpty = (v) => {
  if (v == null) return null;
  const s = String(v);
  return s === "" ? null : s;
};

/** BieMing 首逗号段 = 本草药名联结键。半角逗号优先，回退全角。
 *  派生键做 trim（它用于 join zhong_yao.zhong_yao_name），但 `bie_ming` 原文不动。 */
function deriveBencaoYaoName(bieMing) {
  if (bieMing == null) return null;
  const s = String(bieMing);
  if (s === "") return null;
  const first = s.split(/[,，]/)[0];
  const trimmed = first == null ? "" : first.trim();
  return trimmed === "" ? null : trimmed;
}

// ---- 1) 读源 ----
const bodyRows = [...iterInsertRows(readFileSync(join(SRC, "BookChapterBody.sql"), "utf8"))];
const chapterRows = [...iterInsertRows(readFileSync(join(SRC, "BookChapter.sql"), "utf8"))];

if (bodyRows.length !== EXPECTED.rows) {
  throw new Error(`正文行数应为 ${EXPECTED.rows}，实得 ${bodyRows.length}`);
}

// ---- 2) 本地 D1：取卷章映射（源 Chapter Id → 新 book_chapter.id） ----
let db = null;
try {
  db = localDbHandle();
} catch (error) {
  console.warn("无法打开本地 D1（跳过卷章映射校验）：", error.message);
}

const chapterIdByLegacy = new Map();
const zhongYaoNames = new Set();
if (db) {
  try {
    const rows = db
      .prepare("SELECT id, source_chapter_legacy_id FROM book_chapter")
      .all();
    for (const row of rows) {
      const legacy = asText(row.source_chapter_legacy_id);
      if (legacy) chapterIdByLegacy.set(legacy, asText(row.id));
    }
    console.log("本地卷章映射：", chapterIdByLegacy.size, "条");
  } catch (error) {
    // 迁移 0181 还没应用到本地库：build-only 仍可验源侧统计，--apply 会被拦下。
    console.warn("本地无 book_chapter 表（请先应用迁移 0181/0182）：", error.message);
  }
  try {
    const yaoRows = db.prepare("SELECT zhong_yao_name FROM zhong_yao").all();
    for (const row of yaoRows) {
      const name = asText(row.zhong_yao_name).trim();
      if (name) zhongYaoNames.add(name);
    }
    console.log("本地本草主数据：", zhongYaoNames.size, "条（仅用于自检，不写入）");
  } catch {
    console.warn("本地无 zhong_yao 表，跳过「命中主数据」自检");
  }
}

// ---- 3) 逐行映射 + 派生 ----
const records = [];
const stats = {
  markers: {"$a{": 0, "$m{": 0, "$n{": 0, "$x{": 0, "$r{": 0},
  lfSectionText: 0,
  lfSectionNote: 0,
  crSectionTextRows: 0,
  crSectionTextChars: 0,
  indentSectionText: 0,
  indentSectionNote: 0,
  trailSpaceSectionText: 0,
  trailSpaceSectionNote: 0,
  bencaoRows: 0,
  bencaoLevelMain: 0,
  bencaoLevelAlt: 0,
  fangJiNull: 0,
  orphanChapters: 0,
};
const usedIds = new Set();

for (const row of bodyRows) {
  const legacyChapterId = asText(rowValue(row, "BookChapterId"));
  const newChapterId = chapterIdByLegacy.get(legacyChapterId);
  if (db && !newChapterId) stats.orphanChapters += 1;

  const sectionText = asText(rowValue(row, "SectionText"));
  const sectionNote = rawText(rowValue(row, "SectionNote"));
  const bieMing = rawText(rowValue(row, "BieMing"));
  const bencaoYaoName = deriveBencaoYaoName(bieMing);
  const bencaoLevel = rawText(rowValue(row, "Extend01"));
  const fangJi = nullIfEmpty(rowValue(row, "FangJi"));
  const videoMemo = rawText(rowValue(row, "SectionVideoMemo"));

  // 标记计数（原样存储，不解析）
  for (const [marker, count] of Object.entries(stats.markers)) {
    const hits = sectionText.split(marker).length - 1;
    if (hits > 0) stats.markers[marker] = count + hits;
  }

  // 格式保真统计
  if (sectionText.includes("\n")) stats.lfSectionText += 1;
  if (sectionNote && sectionNote.includes("\n")) stats.lfSectionNote += 1;
  const crInText = sectionText.split("\r").length - 1;
  if (crInText > 0) {
    stats.crSectionTextRows += 1;
    stats.crSectionTextChars += crInText;
  }
  if (/^[ \t]/.test(sectionText)) stats.indentSectionText += 1;
  if (sectionNote && /^[ \t]/.test(sectionNote)) stats.indentSectionNote += 1;
  if (/[ \t]$/.test(sectionText)) stats.trailSpaceSectionText += 1;
  if (sectionNote && /[ \t]$/.test(sectionNote)) stats.trailSpaceSectionNote += 1;

  if (bencaoYaoName) stats.bencaoRows += 1;
  if (bencaoLevel === "0") stats.bencaoLevelMain += 1;
  if (bencaoLevel === "1") stats.bencaoLevelAlt += 1;
  if (fangJi === null) stats.fangJiNull += 1;

  let id = randomShortUUID();
  while (usedIds.has(id)) id = randomShortUUID();
  usedIds.add(id);

  const createdAt = asText(rowValue(row, "CreateDate")).replace("T", " ").slice(0, 19);

  records.push({
    id,
    bookChapterId: newChapterId ?? null,
    receiptNo: Number(rowValue(row, "ReceiptNo") ?? 0),
    sectionText,
    sectionNote,
    fangJi,
    fangJiZhujie: rawText(rowValue(row, "FangJiZhujie")),
    bieMing,
    bencaoYaoName,
    bencaoLevel,
    isEnable: Number(rowValue(row, "IsEnable") ?? 0),
    signatureId: rawText(rowValue(row, "SignatureId")),
    signature: rawText(rowValue(row, "Signature")),
    ext1: videoMemo,
    createdAt: createdAt || new Date().toISOString().slice(0, 19).replace("T", " "),
  });
}

// ---- 4) 派生列统计 ----
const distinctYaoNames = new Set(
  records.map((r) => r.bencaoYaoName).filter((name) => name != null),
);
const hitZhongYao = zhongYaoNames.size > 0
  ? [...distinctYaoNames].filter((name) => zhongYaoNames.has(name)).length
  : null;

// ---- 5) 自检 ----
const failures = [];
const check = (label, actual, expected) => {
  if (expected === null) return;
  if (actual !== expected) failures.push(`${label}: 期望 ${expected}，实得 ${actual}`);
};

check("行数", records.length, EXPECTED.rows);
const mappingReady = chapterIdByLegacy.size > 0;
check("卷章关联悬空", mappingReady ? stats.orphanChapters : 0, 0);
for (const [marker, expected] of Object.entries(EXPECTED.markers)) {
  check(`标记 ${marker}`, stats.markers[marker], expected);
}
check("本草行数（bencao_yao_name 非空）", stats.bencaoRows, EXPECTED.bencaoRows);
check("本草药名去重", distinctYaoNames.size, EXPECTED.bencaoYaoNames);
if (hitZhongYao !== null) check("命中 zhong_yao 主数据", hitZhongYao, 132);
check("bencao_level '0'", stats.bencaoLevelMain, EXPECTED.bencaoLevelMain);
check("bencao_level '1'", stats.bencaoLevelAlt, EXPECTED.bencaoLevelAlt);
check("fang_ji NULL（含空串归一）", stats.fangJiNull, EXPECTED.fangJiNullAfterNormalize);

// 格式保真
check("LF section_text 行数", stats.lfSectionText, EXPECTED.lfSectionText);
check("LF section_note 行数", stats.lfSectionNote, EXPECTED.lfSectionNote);
check("CR section_text 行数", stats.crSectionTextRows, EXPECTED.crSectionTextRows);
check("CR section_text 字符数", stats.crSectionTextChars, EXPECTED.crSectionTextChars);
check("前导缩进 section_text", stats.indentSectionText, EXPECTED.indentSectionText);
check("前导缩进 section_note", stats.indentSectionNote, EXPECTED.indentSectionNote);
check("行尾空格 section_text", stats.trailSpaceSectionText, EXPECTED.trailSpaceSectionText);
check("行尾空格 section_note", stats.trailSpaceSectionNote, EXPECTED.trailSpaceSectionNote);

// 解析残留：`parse.ts` 的 mysqlUnescape 漏还原时会剩这些字面量（源里没有任何反斜杠）
check(
  "SectionText 残留字面 \\'",
  records.filter((r) => r.sectionText.includes("\\'")).length,
  0,
);
check(
  "SectionText 残留字面 \\n / \\r / \\t",
  records.filter((r) => /\\[nrt]/.test(r.sectionText)).length,
  0,
);

// 关联与卷章内唯一性：映射就绪时不允许空 chapterId，也不允许同卷章重号
check(
  "book_chapter_id 缺失",
  mappingReady ? records.filter((r) => !r.bookChapterId).length : 0,
  0,
);
const receiptKeys = new Set();
let duplicateReceipts = 0;
for (const record of records) {
  const key = `${record.bookChapterId}#${record.receiptNo}`;
  if (receiptKeys.has(key)) duplicateReceipts += 1;
  receiptKeys.add(key);
}
check("卷章内 receipt_no 重复", duplicateReceipts, 0);
check(
  "SectionText 空值行数",
  records.filter((r) => r.sectionText === "").length,
  EXPECTED.emptySectionText,
);

// ---- 6) 报告 ----
mkdirSync(OUT, {recursive: true});
const report = {
  mode: APPLY ? "build+apply" : "build-only",
  rows: records.length,
  sourceChapterRows: chapterRows.length,
  chapterMapping: chapterIdByLegacy.size,
  orphanChapters: stats.orphanChapters,
  markers: stats.markers,
  bencao: {
    rows: stats.bencaoRows,
    distinctYaoNames: distinctYaoNames.size,
    hitZhongYao,
    levelMain: stats.bencaoLevelMain,
    levelAlt: stats.bencaoLevelAlt,
  },
  format: {
    lfSectionText: stats.lfSectionText,
    lfSectionNote: stats.lfSectionNote,
    crSectionTextRows: stats.crSectionTextRows,
    crSectionTextChars: stats.crSectionTextChars,
    indentSectionText: stats.indentSectionText,
    indentSectionNote: stats.indentSectionNote,
    trailSpaceSectionText: stats.trailSpaceSectionText,
    trailSpaceSectionNote: stats.trailSpaceSectionNote,
  },
  fangJiNull: stats.fangJiNull,
  failures,
};
writeFileSync(join(OUT, "summary.json"), JSON.stringify(report, null, 2) + "\n");

console.log("=== 正文导入自检 ===");
console.log("行数：", records.length, " 卷章映射：", chapterIdByLegacy.size, " 悬空：", stats.orphanChapters);
console.log("标记：", JSON.stringify(stats.markers));
console.log("本草：行", stats.bencaoRows, " 去重", distinctYaoNames.size, " 命中主数据", hitZhongYao,
  " 等级0", stats.bencaoLevelMain, " 等级1", stats.bencaoLevelAlt);
console.log("格式：LF text", stats.lfSectionText, "/ note", stats.lfSectionNote,
  " CR text 行", stats.crSectionTextRows, "字符", stats.crSectionTextChars,
  " 缩进 text", stats.indentSectionText, "/ note", stats.indentSectionNote,
  " 行尾空格 text", stats.trailSpaceSectionText, "/ note", stats.trailSpaceSectionNote);
console.log("fang_ji NULL：", stats.fangJiNull);

if (failures.length) {
  console.error("自检 FAIL：");
  for (const failure of failures) console.error("  - " + failure);
  console.error("已中止（不写入）。报告：", join(OUT, "summary.json"));
  process.exit(1);
}
console.log("自检全部通过。报告：", join(OUT, "summary.json"));

// ---- 7) 应用 ----
if (!APPLY) {
  console.log("build-only 完成（未写库）。加 --apply 写入本地 D1。");
  process.exit(0);
}
if (!db) {
  console.error("无法打开本地 D1，--apply 中止。");
  process.exit(2);
}
if (!mappingReady) {
  console.error(
    "本地 book_chapter 无卷章行（先应用迁移 0181/0182），--apply 中止——" +
    "否则 book_chapter_id 会写成 NULL。",
  );
  process.exit(2);
}
if (zhongYaoNames.size === 0) {
  console.error(
    "本地 zhong_yao 为空（先应用迁移 0180），--apply 中止——否则「命中主数据 132」自检无从执行。",
  );
  process.exit(2);
}

const insertSql =
  "INSERT OR REPLACE INTO book_chapter_body " +
  "(id, book_chapter_id, receipt_no, section_text, section_note, fang_ji, fang_ji_zhujie, " +
  " bie_ming, bencao_yao_name, bencao_level, is_enable, signature_id, signature, " +
  " ext1, created_at, updated_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

db.exec("BEGIN;");
try {
  // 全量重建语义：id 是随机生成的，`INSERT OR REPLACE` 靠主键无法幂等——
  // 复跑会整批再插一遍（8066 变 16132）。先清空再写，重放结果恒定。
  const existing = db.prepare("SELECT COUNT(*) AS c FROM book_chapter_body").get().c;
  if (existing > 0) {
    db.exec("DELETE FROM book_chapter_body");
    console.log("清空既有正文行：", existing);
  }
  const statement = db.prepare(insertSql);
  for (const record of records) {
    statement.run(
      record.id,
      record.bookChapterId,
      record.receiptNo,
      record.sectionText,
      record.sectionNote,
      record.fangJi,
      record.fangJiZhujie,
      record.bieMing,
      record.bencaoYaoName,
      record.bencaoLevel,
      record.isEnable,
      record.signatureId,
      record.signature,
      record.ext1,
      record.createdAt,
      record.createdAt,
    );
  }
  db.exec("COMMIT;");
} catch (error) {
  db.exec("ROLLBACK;");
  console.error("APPLY FAILED:", error.message);
  process.exit(2);
}

// 写入后逐行对账：按自然键把库里的值读回来与内存记录逐字符比对。
// 这是唯一能证明写入路径没丢换行/空格/CR 的环节（内存内自比是自证循环）。
const count = db.prepare("SELECT COUNT(*) AS c FROM book_chapter_body").get();
const reread = new Map();
for (const row of db
  .prepare(
    "SELECT book_chapter_id, receipt_no, section_text, section_note FROM book_chapter_body",
  )
  .all()) {
  reread.set(`${row.book_chapter_id}#${row.receipt_no}`, row);
}

let missingRows = 0;
let textDiff = 0;
let noteDiff = 0;
for (const record of records) {
  const got = reread.get(`${record.bookChapterId}#${record.receiptNo}`);
  if (!got) {
    missingRows += 1;
    continue;
  }
  if (got.section_text !== record.sectionText) textDiff += 1;
  const gotNote = got.section_note ?? null;
  const wantNote = record.sectionNote ?? null;
  if (gotNote !== wantNote) noteDiff += 1;
}

console.log(
  "应用完成：book_chapter_body 现 =", count.c,
  " 对账缺失", missingRows, " Text 不一致", textDiff, " Note 不一致", noteDiff,
);

if (count.c !== EXPECTED.rows) {
  console.error(`行数 ${count.c} 不等于期望 ${EXPECTED.rows}，导入失败。`);
  process.exit(3);
}
if (missingRows > 0 || textDiff > 0 || noteDiff > 0) {
  console.error("库内内容与源不一致，导入失败。");
  process.exit(3);
}
