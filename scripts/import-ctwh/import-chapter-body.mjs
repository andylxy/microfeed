// 书本卷章正文（book_chapter_body）导入工具 —— 把 ctwh/BookChapterBody.sql 的
// 8066 行正文导入本地 D1，并可生成随迁移分发的部署种子 0186。
//
// 设计要点（照 import-term.mjs / import-yao.mjs 模式）：
//   - 复用 parse.ts 的 iterInsertRows/mysqlUnescape：dump 里的 `\r` `\n` `\t` `\'`
//     全部还原成真实控制字符。**全格式保真**（ADR-0062 决策 6）——不 trim、不 strip、
//     不归一换行、不折叠空白。正文的前导缩进、句号后空格、真实换行、字面 CR 都是内容。
//   - 写入走**参数化语句**（db.prepare(...).run(...)），不拼 SQL 字符串：文本原样进库、
//     不生成 SQL 文件、不触发 `git diff --check` 的尾随空白红线。
//   - **全量导入 8066 行**（930 本草 + 7136 经典）。严禁按 IsEnable 过滤——只导启用
//     会丢 7136 行经典正文。
//   - 卷章关联：源 BookChapterBody.BookChapterId 是源 BookChapter.Id，经冻结映射
//     `book-chapter-ids.json`（0182 种子写死的 445 个 id）映射到新 id。生成部署种子
//     时不读本地 D1，任何位置重跑结果逐字节一致。
//   - 本草派生列：`bencao_yao_name` = BieMing 首逗号段、`bencao_level` = 源 Extend01。
//     只存档、**不回写 zhong_yao**（ADR-0062 决策 3）。
//   - `--emit-migration` 生成 0186 部署种子：id 确定性（`bc`+9 位）、
//     `INSERT OR IGNORE` 幂等、LF/TAB/CR 编码为哨兵后运行时 `replace(char(10))` 还原，
//     按单条 <80KB 拆批（D1 单语句 100KB 上限）。详见 6.5 节。
//
// 自检（任一不符 fail-fast，`--apply` / `--emit-migration` 时中止）：
//   行数 8066 / 关联 0 悬空 / 标记计数 / 本草派生 /
//   格式保真（SectionText/SectionNote/ext1 三列的 LF·CR·缩进·句号后空格 + 全列 LF 总量）/
//   哨兵 0 冲突 / id 唯一 / 单条语句 <80KB。
//
// 用法：
//   node --import tsx scripts/import-ctwh/import-chapter-body.mjs [--apply] [--src ctwh]
//   node --import tsx scripts/import-ctwh/import-chapter-body.mjs --emit-migration migrations/0186_seed_book_chapter_body.sql
//   --apply  实际写入本地 D1（默认只构建 + 自检，不写库）
//   --emit-migration <path>  生成部署种子迁移 SQL（不写库）

import {readFileSync, readdirSync, writeFileSync, mkdirSync} from "node:fs";
import {join, resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {iterInsertRows, rowValue} from "./parse.ts";
import {
  chunkByBytes,
  encodeLiteral,
  SENTINELS,
  textExpr,
} from "./sql-emit.mjs";

const INSTANCE = "ctwh-881019-xyz";
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const EMIT_MIGRATION = args.includes("--emit-migration")
  ? resolve(args[args.indexOf("--emit-migration") + 1])
  : null;
const SRC = resolve(args.includes("--src") ? args[args.indexOf("--src") + 1] : "ctwh");
const OUT = resolve(
  args.includes("--out") ? args[args.indexOf("--out") + 1] : "ctwh-books/chapter-body/out",
);
/** 0182 种子写死的「源 Chapter Id → 新 id」冻结映射，生成部署种子的唯一依据。 */
const CHAPTER_IDS = JSON.parse(
  readFileSync(new URL("./book-chapter-ids.json", import.meta.url), "utf8"),
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
  // SectionVideoMemo → ext1：非空 5 行，其中 3 行含 LF（共 29 个）、1 行前导缩进、
  // 1 行行尾空格；CR/TAB 均 0。此前格式自检只覆盖 SectionText/SectionNote，
  // ext1 的换行虽由哨兵正确还原，却不在统计基线里（code-review 口径缺口）。
  ext1Rows: 5,
  lfExt1Rows: 3,
  lfExt1Chars: 29,
  crExt1Chars: 0,
  tabExt1Chars: 0,
  indentExt1: 1,
  trailSpaceExt1: 1,
  // 全列 LF 字符总数（SectionText 1267 + SectionNote 16750 + ext1 29）。
  // 单列计数之外再锁一次总量，避免新增文本列时漏进基线。
  allColumnLfChars: 18046,
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

function deterministicBodyId(sequence) {
  // `bc` + 9 位补零 = 11 字符，与 VARCHAR(11) 一致。源文件顺序固定，逐字节可复现；
  // 且与 `--emit-migration` 写死进 0186 的 id 一致，重放 0186 对已种库纯幂等跳过。
  return "bc" + String(sequence).padStart(9, "0");
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

// ---- 2) 卷章映射 + 本地 D1 ----
// 卷章关联一律走 0182 冻结映射，生成部署种子时不读本地库：任何位置重跑结果一致。
const chapterIdByLegacy = new Map(Object.entries(CHAPTER_IDS));
console.log("冻结卷章映射：", chapterIdByLegacy.size, "条");

// 本地 D1 仅用于 `--apply` 写入与「命中本草主数据」自检；build-only /
// `--emit-migration` 没有本地实例也能跑完。
let db = null;
try {
  db = localDbHandle();
} catch (error) {
  console.warn("无法打开本地 D1（跳过本地自检）：", error.message);
}

const zhongYaoNames = new Set();
if (db) {
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
  ext1Rows: 0,
  lfExt1Rows: 0,
  lfExt1Chars: 0,
  crExt1Chars: 0,
  tabExt1Chars: 0,
  indentExt1: 0,
  trailSpaceExt1: 0,
  allColumnLfChars: 0,
  bencaoRows: 0,
  bencaoLevelMain: 0,
  bencaoLevelAlt: 0,
  fangJiNull: 0,
  orphanChapters: 0,
};
const usedIds = new Set();

for (const [index, row] of bodyRows.entries()) {
  const legacyChapterId = asText(rowValue(row, "BookChapterId"));
  const newChapterId = chapterIdByLegacy.get(legacyChapterId);
  if (!newChapterId) stats.orphanChapters += 1;

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

  // 格式保真统计。三列（SectionText / SectionNote / ext1）分别计行数，
  // 并把 LF 字符数累加成全列总量，锁住哨兵还原后的换行总数。
  const lfInText = sectionText.split("\n").length - 1;
  const lfInNote = sectionNote ? sectionNote.split("\n").length - 1 : 0;
  if (lfInText > 0) stats.lfSectionText += 1;
  if (lfInNote > 0) stats.lfSectionNote += 1;
  stats.allColumnLfChars += lfInText + lfInNote;
  const crInText = sectionText.split("\r").length - 1;
  if (crInText > 0) {
    stats.crSectionTextRows += 1;
    stats.crSectionTextChars += crInText;
  }
  if (/^[ \t]/.test(sectionText)) stats.indentSectionText += 1;
  if (sectionNote && /^[ \t]/.test(sectionNote)) stats.indentSectionNote += 1;
  if (/[ \t]$/.test(sectionText)) stats.trailSpaceSectionText += 1;
  if (sectionNote && /[ \t]$/.test(sectionNote)) stats.trailSpaceSectionNote += 1;
  if (videoMemo != null && videoMemo !== "") {
    stats.ext1Rows += 1;
    const lfInExt1 = videoMemo.split("\n").length - 1;
    if (lfInExt1 > 0) stats.lfExt1Rows += 1;
    stats.lfExt1Chars += lfInExt1;
    stats.allColumnLfChars += lfInExt1;
    stats.crExt1Chars += videoMemo.split("\r").length - 1;
    stats.tabExt1Chars += videoMemo.split("\t").length - 1;
    if (/^[ \t]/.test(videoMemo)) stats.indentExt1 += 1;
    if (/[ \t]$/.test(videoMemo)) stats.trailSpaceExt1 += 1;
  }

  if (bencaoYaoName) stats.bencaoRows += 1;
  if (bencaoLevel === "0") stats.bencaoLevelMain += 1;
  if (bencaoLevel === "1") stats.bencaoLevelAlt += 1;
  if (fangJi === null) stats.fangJiNull += 1;

  const id = deterministicBodyId(index + 1);
  if (usedIds.has(id)) throw new Error(`正文 id 重复：${id}`);
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
// ext1（SectionVideoMemo）此前只在 verifyNoSentinel 里防哨兵冲突，换行/缩进不在
// 统计基线；补齐后三列都进 fail-fast，且用全列 LF 总量兜住新增文本列。
check("ext1 非空行数", stats.ext1Rows, EXPECTED.ext1Rows);
check("LF ext1 行数", stats.lfExt1Rows, EXPECTED.lfExt1Rows);
check("LF ext1 字符数", stats.lfExt1Chars, EXPECTED.lfExt1Chars);
check("CR ext1 字符数", stats.crExt1Chars, EXPECTED.crExt1Chars);
check("TAB ext1 字符数", stats.tabExt1Chars, EXPECTED.tabExt1Chars);
check("前导缩进 ext1", stats.indentExt1, EXPECTED.indentExt1);
check("行尾空格 ext1", stats.trailSpaceExt1, EXPECTED.trailSpaceExt1);
check("全列 LF 字符总数", stats.allColumnLfChars, EXPECTED.allColumnLfChars);

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
  mode: APPLY ? "build+apply" : EMIT_MIGRATION ? "build+emit-migration" : "build-only",
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
    ext1Rows: stats.ext1Rows,
    lfExt1Rows: stats.lfExt1Rows,
    lfExt1Chars: stats.lfExt1Chars,
    crExt1Chars: stats.crExt1Chars,
    tabExt1Chars: stats.tabExt1Chars,
    indentExt1: stats.indentExt1,
    trailSpaceExt1: stats.trailSpaceExt1,
    allColumnLfChars: stats.allColumnLfChars,
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
console.log("ext1：非空行", stats.ext1Rows, " LF 行", stats.lfExt1Rows, "字符", stats.lfExt1Chars,
  " CR", stats.crExt1Chars, " TAB", stats.tabExt1Chars,
  " 缩进", stats.indentExt1, " 行尾空格", stats.trailSpaceExt1);
console.log("全列 LF 字符总数：", stats.allColumnLfChars);
console.log("fang_ji NULL：", stats.fangJiNull);

if (failures.length) {
  console.error("自检 FAIL：");
  for (const failure of failures) console.error("  - " + failure);
  console.error("已中止（不写入）。报告：", join(OUT, "summary.json"));
  process.exit(1);
}
console.log("自检全部通过。报告：", join(OUT, "summary.json"));

// ---- 6.5) --emit-migration：生成部署种子迁移 0186（deploy-anywhere 默认数据）----
// 用户裁定「当前模块数据设为默认数据，部署到其他位置也自带」（2026-11-06），
// 范式照 ADR-0065 / import-fangyao.mjs。约束三条（缺一不可）：
//   1. D1 单语句 100KB 上限 → 按累计字节 <80KB 分块（多行 VALUES，留 20KB 余量）。
//   2. `git diff --check` 红线只查物理行尾空白 → 文本里的 LF/TAB/CR 编码为
//      `@@NL@@`/`@@TB@@`/`@@CR@@` 哨兵，迁移文件每条 VALUES 保持单物理行，
//      运行时用 `replace(..., '@@NL@@', char(10))` 还原——字节级保真且无行尾红线。
//   3. id 确定性（`bc`+9 位）、`INSERT OR IGNORE` 幂等（主键 +
//      UNIQUE(book_chapter_id, receipt_no) 双保险），与 `--apply` 同源。
// 卷章 id 来自 0182 冻结映射，迁移按 0181 建表 → 0182 目录 → 0186 正文的顺序应用。
// SENTINELS / encodeLiteral / textExpr / chunkByBytes 见 ./sql-emit.mjs（与 import-fangyao 共用）。

/** 任一文本列含哨兵原文则中止：否则运行时 replace 会把内容改掉。 */
function verifyNoSentinel() {
  const fields = [
    "sectionText", "sectionNote", "fangJi", "fangJiZhujie", "bieMing",
    "bencaoYaoName", "bencaoLevel", "signatureId", "signature", "ext1",
    "createdAt", "bookChapterId", "id",
  ];
  for (const record of records) {
    for (const field of fields) {
      const value = record[field];
      if (value == null) continue;
      const hit = SENTINELS.find((sentinel) => String(value).includes(sentinel));
      if (hit) {
        throw new Error(
          `第 ${field} 列含哨兵 ${hit}，请换哨兵：${String(value).slice(0, 40)}`,
        );
      }
    }
  }
}

// chunkByBytes 见 ./sql-emit.mjs。

function bodyRowSql(row) {
  return `(${[
    encodeLiteral(row.id),
    encodeLiteral(row.bookChapterId),
    row.receiptNo,
    textExpr(row.sectionText),
    textExpr(row.sectionNote),
    textExpr(row.fangJi),
    textExpr(row.fangJiZhujie),
    textExpr(row.bieMing),
    textExpr(row.bencaoYaoName),
    textExpr(row.bencaoLevel),
    row.isEnable,
    textExpr(row.signatureId),
    textExpr(row.signature),
    textExpr(row.ext1),
    encodeLiteral(row.createdAt),
    encodeLiteral(row.createdAt),
  ].join(", ")})`;
}

function emitMigrationSql() {
  verifyNoSentinel();
  const header = [
    "-- 卷章正文默认数据（deploy-anywhere 种子，ADR-0062）——由 import-chapter-body.mjs 生成，",
    "-- 勿手改。部署到任何位置，book_chapter_body 都自带同一份 8066 行数据",
    "-- （与 ctwh/BookChapterBody.sql 逐字节一致，含本草 930 + 经典 7136）。",
    "--",
    "-- 依赖顺序：0181 建表 → 0182 卷章目录种子 → 本迁移。卷章 id 取自",
    "-- scripts/import-ctwh/book-chapter-ids.json（0182 冻结映射），不读运行期库。",
    "--",
    "-- 生成约束：① D1 单语句 100KB 上限，按 <80KB 分块；② 文本 LF/TAB/CR 编码为",
    "-- @@NL@@/@@TB@@/@@CR@@ 哨兵，运行时 replace(..., char(10)) 还原，每条 VALUES",
    "-- 保持单物理行，不触发 git diff --check 行尾红线；③ id 写死、INSERT OR IGNORE 幂等。",
    "--",
    "-- 格式保真：不 trim、不 strip、不归一换行。源数据的前导缩进、句号后空格、",
    "-- 真实换行、字面 CR 都是内容；哨兵只在 SQL 文本里代替控制字符，落库即还原。",
    "--",
  ].join("\n");

  const columns =
    "(id, book_chapter_id, receipt_no, section_text, section_note, fang_ji, " +
    "fang_ji_zhujie, bie_ming, bencao_yao_name, bencao_level, is_enable, " +
    "signature_id, signature, ext1, created_at, updated_at) VALUES\n";

  const lines = [header];
  const statements = [];
  for (const chunk of chunkByBytes(records, bodyRowSql)) {
    const statement =
      "INSERT OR IGNORE INTO book_chapter_body " + columns +
      chunk.join(",\n") + ";";
    const size = Buffer.byteLength(statement, "utf8");
    if (size > 80 * 1024) {
      throw new Error(`单条 INSERT ${size} B 超过 80KB 上限，需调小分块`);
    }
    statements.push(size);
    lines.push(statement);
  }
  const sql = lines.join("\n") + "\n";
  if (sql.includes("\r")) throw new Error("迁移 SQL 含字面 CR，会破坏物理行");
  if (/(^|\n)[^\n]*[ \t]+\n/.test(sql)) {
    throw new Error("迁移 SQL 存在行尾空白，会触发 git diff --check");
  }
  return {sql, statements};
}

if (EMIT_MIGRATION) {
  const {sql, statements} = emitMigrationSql();
  writeFileSync(EMIT_MIGRATION, sql);
  console.log(
    "部署种子迁移已生成：", EMIT_MIGRATION,
    "（", Buffer.byteLength(sql, "utf8"), "字节，", statements.length,
    " 条语句，单条最大 ", Math.max(...statements), " B）",
  );
}

// ---- 7) 应用 ----
if (!APPLY) {
  console.log("build-only 完成（未写库）。加 --apply 写入本地 D1。");
  process.exit(0);
}
if (!db) {
  console.error("无法打开本地 D1，--apply 中止。");
  process.exit(2);
}
// 卷章关联走冻结映射，但写入前确认本地库已应用 0181/0182 且 id 一致，
// 否则 book_chapter_id 会指向不存在的卷章（无硬外键，逻辑引用需自行把关）。
if (db) {
  try {
    const localIds = new Set(
      db.prepare("SELECT id FROM book_chapter").all().map((row) => asText(row.id)),
    );
    const missing = [...chapterIdByLegacy.values()].filter((id) => !localIds.has(id));
    if (missing.length) {
      console.error(
        `本地 book_chapter 缺 ${missing.length} 个 0182 种子卷章（先应用迁移 0181/0182），--apply 中止。`,
      );
      process.exit(2);
    }
  } catch (error) {
    console.error("本地无 book_chapter 表（先应用迁移 0181/0182），--apply 中止。", error.message);
    process.exit(2);
  }
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
  // 全量重建语义：id 确定性，`INSERT OR REPLACE` 复跑仍是同一批主键，
  // 但先清空再写可让 DELETE/软删过的行一并重建，重放结果恒定。
  // 0186 用 `INSERT OR IGNORE` 幂等，二者 id 同构、互不冲突。
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
