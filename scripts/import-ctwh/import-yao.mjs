// 中药库（yao）定向导入工具 —— 把 ctwh/Yao.sql 的本草条目导入并归属到「中药」书频道。
//
// 设计要点（匹配关系）：
//   - 沿用 build.ts 的精确 yao 行映射（tcmId 确定性 11 位 id、转义还原、代理字符清洗、
//     标记保留、yaoAlias 折叠进 _microfeed.aliases、YaoList→yaoNames、YaoBieMing→bieMing）。
//   - 方剂经 FangBody.YaoID → tcmId("yao", YaoID) 引用 yao，故 yao 的 ITEM ID 必须与
//     build.ts 推导的完全一致，否则方剂对不上。yao 的归属键（book_id + _microfeed.bookId）
//     改写成中药书频道 4KbG9bDqdz3（不落容器 tcmyao00001，本地本就无该容器）。
//   - 不导出频道：中药书频道 4KbG9bDqdz3 本地已存在（用户建的），禁止用 build 产物覆盖它。
//   - 关联卷：中药书是「本草字典」，无篇章/条文层级，卷面板（buildTcmVolumeBoard）只渲染
//     chapter/section，故 yao 默认在卷面板不可见。按用户拍板建一个确定性根 chapter（= 卷），
//     把所有 yao 经 tcm_parent_id 挂到它下面 —— 卷面板即以「中药」为一卷、下列全部药材。
//     yao 的 tcm_kind 仍为 'yao'，不污染 App 条文视图（reads.ts getAppChapterContent 按
//     tcm_kind='section' 过滤）。
//   - 展示修正：① 给每条 yao 写 _microfeed.volume="中药"，让后台条目编辑页「卷名」显示
//     「中药」而非「未分卷」（与 TCM rename 维护的展示字段一致）；② 从正文首段解析序号
//     `N、` 前缀到标题（如 蜀椒 → 38、蜀椒），全部 172 条正文首段均带此序号（= no+1）。
//
// 用法：
//   node --import tsx scripts/import-ctwh/import-yao.mjs [--apply] [--src ctwh] [--out ctwh-books/yao/out]
//   --apply  实际写入本地 D1（默认只构建 + 校验，不落库）

import {readFileSync, writeFileSync, mkdirSync, readdirSync} from "node:fs";
import {join, resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {iterInsertRows, rowValue, rowText} from "./parse.ts";
import {
  buildTargets,
  tcmId,
  countMarkers,
} from "./build.ts";

const TARGET_BOOK_ID = "4KbG9bDqdz3"; // 中药书频道
const ZHONGYAO_CHAPTER_TITLE = "中药";
// 根 chapter（卷）确定性 id：tcmId 把 kind 纳入哈希，与 yao id 不会撞。
const ZHONGYAO_CHAPTER_ID = tcmId("chapter", TARGET_BOOK_ID);
const INSTANCE = "ctwh-881019-xyz";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const SRC = resolve(args.includes("--src") ? args[args.indexOf("--src") + 1] : "ctwh");
const OUT = resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : "ctwh-books/yao/out");

function localDbHandle() {
  const d1Dir = join(".microfeed/instances", INSTANCE, "local-state", "v3/d1/miniflare-D1DatabaseObject");
  const dbFile = readdirSync(d1Dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  if (!dbFile) throw new Error(`未找到本地 D1 sqlite：${d1Dir}`);
  return new DatabaseSync(join(d1Dir, dbFile));
}

// ---- 1) 读源并复用 build.ts 全量映射，仅取 yao ----
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
const {items, report} = buildTargets(tables, null, {}); // 全量：含全部 yao（book_id=容器 tcmyao00001）
const yaoItems = items.filter((it) => it.tcmKind === "yao");
const yaoBySource = new Map(tables.yao.map((r) => [String(rowValue(r, "YaoId") ?? ""), r]));

// ---- 2) 归属改写 + 展示修正：book_id→中药书、tcm_parent_id→根 chapter、volume=中药、标题加序号前缀 ----
// 从正文首段解析序号 N、 → 标题前缀（正文首段形如 "<p>38、$u{蜀椒}</p>"，序号 = no+1）。
function deriveOrdinalPrefix(description) {
  const desc = String(description ?? "");
  const m = desc.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  if (!m) return null;
  const text = m[1].replace(/\$[a-z]\{([^}]*)\}/g, "$1").trim();
  const nm = text.match(/^(\d+)\s*[、.．.]/);
  return nm ? nm[1] : null;
}
const finalYao = yaoItems.map((it) => {
  const data = JSON.parse(JSON.stringify(it.data));
  const baseTitle = String(data.title ?? "").replace(/^\d+\s*[、.．.]\s*/, ""); // 幂等：先去已有前缀
  const ordinal = deriveOrdinalPrefix(data.description);
  const title = ordinal ? `${ordinal}、${baseTitle}` : baseTitle;
  data.title = title;
  data._microfeed = {...(data._microfeed ?? {}), bookId: TARGET_BOOK_ID, volume: ZHONGYAO_CHAPTER_TITLE};
  return {...it, bookId: TARGET_BOOK_ID, tcmParentId: ZHONGYAO_CHAPTER_ID, data};
});

// 根 chapter（卷）：让卷面板以「中药」为一卷、下列全部 yao。确定性 id，重导原地替换。
const zhongyaoChapter = {
  id: ZHONGYAO_CHAPTER_ID,
  status: 1,
  bookId: TARGET_BOOK_ID,
  tcmKind: "chapter",
  tcmParentId: null,
  pubDate: "2024-01-01T00:00:00.000Z",
  data: {
    title: ZHONGYAO_CHAPTER_TITLE,
    description: "",
    content_format: "html",
    _microfeed: {bookId: TARGET_BOOK_ID, section: 1},
  },
  contentText: "",
};

// ---- 3) 安全校验：本地已存在的 yao 是否等于 tcmId 推导（防孤儿）；异常 YaoId ----
const warnings = [];
let localDb = null;
try { localDb = localDbHandle(); } catch (e) { warnings.push("无法打开本地 D1 用于校验：" + e.message); }
if (localDb) {
  const existing = localDb
    .prepare("SELECT id, json_extract(data,'$.title') t FROM items WHERE book_id=? AND tcm_kind='yao'")
    .all(TARGET_BOOK_ID);
  const existingByName = new Map(existing.map((r) => [r.t, r.id]));
  const srcByName = new Map();
  for (const r of tables.yao) srcByName.set(rowText(r, "YaoName").trim(), tcmId("yao", String(rowValue(r, "YaoId") ?? "")));
  let mismatch = 0;
  for (const [name, localId] of existingByName) {
    const derived = srcByName.get(name);
    if (derived && derived !== localId) {
      warnings.push(`id 不一致：「${name}」本地=${localId} 推导=${derived} —— 重导会新建行，旧行变孤儿`);
      mismatch += 1;
    }
  }
  if (mismatch === 0) {
    console.log(`id 一致性：本地 ${existing.length} 条 yao 全部与 tcmId 推导一致（重导入原地替换，无孤儿）`);
  }
  const badIds = tables.yao.filter((r) => { const v = Number(rowValue(r, "YaoId")); return !Number.isFinite(v) || v <= 0; });
  if (badIds.length) warnings.push(`源异常 YaoId 行：${badIds.length}（YaoId<=0 或非数字），仍会正常派生 id`);
  // 中药书若已有非本脚本派生的 chapter，重导会保留它们为独立卷（不删除）。
  const existingChapters = localDb.prepare("SELECT id FROM items WHERE book_id=? AND tcm_kind='chapter'").all(TARGET_BOOK_ID);
  const strayChapters = existingChapters.filter((r) => r.id !== ZHONGYAO_CHAPTER_ID);
  if (strayChapters.length) warnings.push(`中药书已有 ${strayChapters.length} 个非预期 chapter（${strayChapters.map((r) => r.id).join(",")}），重导会保留为独立卷`);
}

// ---- 4) 残留转义 / 标记 复核（安全网，build 已保证，这里再核 yao 子集） ----
let residualEscapes = 0;
for (const it of finalYao) {
  const desc = String(it.data.description ?? "");
  const title = String(it.data.title ?? "");
  const ct = it.contentText;
  for (const t of [desc, title, ct]) if (/\\+[nrt'"\\]/.test(t)) residualEscapes += 1;
}

// ---- 5) 写产物（仅 yao 条目，不写频道） ----
mkdirSync(OUT, {recursive: true});
writeFileSync(join(OUT, "tcm-channels.sql"), ""); // 空：中药书频道本地已存在，勿覆盖
const itemStatement = (item) => {
  const timestamp = item.pubDate ?? "2024-01-01T00:00:00.000Z";
  return (
    "INSERT OR REPLACE INTO items " +
    "(id, status, data, pub_date, created_at, updated_at, content_text, content_text_updated_at, " +
    "content_text_revision, review_status, book_id, tcm_kind, tcm_parent_id) VALUES (" +
    [
      `'${item.id}'`, String(item.status), `'${JSON.stringify(item.data).replace(/'/g, "''")}'`,
      item.pubDate ? `'${item.pubDate}'` : "NULL", `'${timestamp}'`, `'${timestamp}'`,
      `'${item.contentText.replace(/'/g, "''")}'`, `'${timestamp}'`, "1", "NULL",
      `'${item.bookId}'`, `'${item.tcmKind}'`, item.tcmParentId ? `'${item.tcmParentId}'` : "NULL",
    ].join(", ") + ");"
  );
};
const STATEMENTS_PER_BATCH = 300;
const ordered = [zhongyaoChapter, ...finalYao]; // 根 chapter 排在最前，保证先于 yao 落库
const batches = [];
for (let i = 0; i < ordered.length; i += STATEMENTS_PER_BATCH) {
  batches.push(ordered.slice(i, i + STATEMENTS_PER_BATCH).map(itemStatement));
}
batches.forEach((b, i) => writeFileSync(join(OUT, `tcm-batch-${String(i + 1).padStart(3, "0")}.sql`), b.join("\n") + "\n"));

const summary = {
  targetBookId: TARGET_BOOK_ID,
  rootChapterId: ZHONGYAO_CHAPTER_ID,
  rootChapterTitle: ZHONGYAO_CHAPTER_TITLE,
  mode: APPLY ? "build+apply" : "build-only",
  yaoCount: finalYao.length,
  titlesPrefixed: finalYao.filter((it) => /^\d+[、.．.]/.test(String(it.data.title ?? ""))).length,
  sourceYaoRows: tables.yao.length,
  buildReportMarkers: `${report.markerCountSource}/${report.markerCountOutput}`,
  buildReportResidualEscapes: report.residualEscapes,
  yaoSubsetResidualEscapes: residualEscapes,
  batches: batches.length,
  warnings,
  outputDir: OUT,
};
writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2) + "\n");

console.log("=== yao 导入构建结果 ===");
console.log("目标书：", TARGET_BOOK_ID, "（中药）");
console.log("yao 条目数：", finalYao.length, "（源 Yao.sql", tables.yao.length, "行）");
console.log("build 标记 源/产物：", summary.buildReportMarkers, " build 残留转义：", report.residualEscapes, " yao 子集残留转义：", residualEscapes);
console.log("批次文件：", batches.length, "→", OUT);
if (warnings.length) { console.warn("警告："); for (const w of warnings) console.warn("  - " + w); }

// ---- 6) 应用（--apply） ----
if (APPLY) {
  const db = localDbHandle();
  db.exec("PRAGMA recursive_triggers=ON;");
  db.exec("BEGIN;");
  try {
    for (const b of batches) for (const stmt of b) db.exec(stmt);
    db.exec("COMMIT;");
  } catch (e) {
    db.exec("ROLLBACK;");
    console.error("APPLY FAILED:", e.message);
    process.exit(2);
  }
  const after = db.prepare("SELECT COUNT(*) c FROM items WHERE book_id=? AND tcm_kind='yao'").get(TARGET_BOOK_ID);
  const withAlias = db.prepare("SELECT COUNT(*) c FROM items WHERE book_id=? AND tcm_kind='yao' AND json_array_length(json_extract(data,'$._microfeed.aliases'))>0").get(TARGET_BOOK_ID);
  const withNames = db.prepare("SELECT COUNT(*) c FROM items WHERE book_id=? AND tcm_kind='yao' AND json_extract(data,'$._microfeed.yaoNames')!=''").get(TARGET_BOOK_ID);
  const chapters = db.prepare("SELECT COUNT(*) c FROM items WHERE book_id=? AND tcm_kind='chapter'").get(TARGET_BOOK_ID);
  const reparented = db.prepare("SELECT COUNT(*) c FROM items WHERE book_id=? AND tcm_kind='yao' AND tcm_parent_id=?").get(TARGET_BOOK_ID, ZHONGYAO_CHAPTER_ID);
  console.log("应用完成：中药书 yao 现 =", after.c, "（含别名", withAlias.c, "，含 yaoNames", withNames.c, "）");
  console.log("根 chapter：", chapters.c, " 已挂到 chapter 的 yao：", reparented.c, "/", after.c);
  const gui = db.prepare("SELECT id FROM items WHERE book_id=? AND tcm_kind='yao' AND json_extract(data,'$.title')='桂枝'").get(TARGET_BOOK_ID);
  console.log("桂枝 item id =", gui ? gui.id : "(未找到)");
}
