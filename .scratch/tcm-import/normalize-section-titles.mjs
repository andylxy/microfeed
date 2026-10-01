/**
 * 规范化 TCM 条文（section）标题：把源脏标题「第XXXXXX条・<篇章名>」缩短为
 * 卷内章号数字（与《伤寒杂病论・(桂林古本)》既有的 "1/2/3" 模式一致）。
 *
 * 背景：round 8 的 backfill-tcm-volume.mjs 已给全部 TCM 条文写好
 * `_microfeed.chapterNo`（卷内 1..N）；更早的 tcm-status-title.mjs 把 title 缩成
 * `CAST(chapterNo)` —— 但那次跑在 9 部新书导入之前，故新书条文仍是脏标题。
 *
 * 本脚本只动 title（展示字段，不进任何 App 端点 / golden 契约），不改状态、不改结构。
 * 幂等：title 已是纯数字的条文不会被改写。
 *
 * 用法：
 *   node --import tsx .scratch/tcm-import/normalize-section-titles.mjs            # 预览
 *   node --import tsx .scratch/tcm-import/normalize-section-titles.mjs --apply   # 执行
 */
import {DatabaseSync} from "node:sqlite";
import {readdirSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const instanceDir = join(
  here,
  "../../.microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/miniflare-D1DatabaseObject",
);
const dbFile = readdirSync(instanceDir).find(
  (f) => f.endsWith(".sqlite") && f !== "metadata.sqlite",
);
if (!dbFile) throw new Error(`未找到本地 D1 sqlite：${instanceDir}`);
const db = new DatabaseSync(join(instanceDir, dbFile));

// 9 部「后来导入」的 TCM 章节书（channelId，来自 ctwh-books/books.json 已导入子集）。
// 不含桂林古本(5IGM9t76quT)——其 title 已是数字（幂等不改）；不含 yao/term 平铺书——其 title 是药名/名词名。
const NEW_BOOK_IDS = new Set([
  "XNK0VFX39Xv", // 9040000 伤寒论・(人纪)
  "q6u5siNb2hT", // 10001 伤寒金匮・(宋版)
  "ydyQltIuQv6", // 10002 金匮要略・(宋版)
  "Kcb7X2K5LTh", // 9050000 金匮要略・(宋版)
  "tZYk25WiJ0R", // 20100000 难经
  "drsRImTi5tv", // 20200000 黄帝内经・素问
  "ghBqURJwurj", // 20300000 黄帝内经・灵枢
  "ZhuBd0Vj7kl", // 9020000 神农本草经・(人纪)
  "OsOP62cyp3j", // 400100 神农本草经疏
]);

const apply = process.argv.includes("--apply");

// 预览：列出将被改写的脏标题样本
const dirty = db
  .prepare(
    `SELECT id, json_extract(data, '$.title') AS title,
            json_extract(data, '$._microfeed.chapterNo') AS chNo
     FROM items
     WHERE tcm_kind = 'section' AND book_id = ?
       AND json_extract(data, '$.title') LIKE '第%条%'
     ORDER BY CAST(json_extract(data, '$._microfeed.chapterNo') AS INTEGER)
     LIMIT 6`,
  );

console.log(`DB: ${dbFile}`);
console.log(`APPLY MODE: ${apply ? "YES (write)" : "NO (dry-run)"}`);
console.log(`scope books: ${[...NEW_BOOK_IDS].length}`);

let total = 0;
let willChange = 0;
for (const bookId of NEW_BOOK_IDS) {
  const rows = db
    .prepare(
      `SELECT id, json_extract(data, '$.title') AS title,
              json_extract(data, '$._microfeed.chapterNo') AS chNo
       FROM items
       WHERE tcm_kind = 'section' AND book_id = ? AND status != 3`,
    )
    .all(bookId);
  const dirtyRows = rows.filter(
    (r) => typeof r.title === "string" && r.title.startsWith("第") && r.title.includes("条"),
  );
  total += rows.length;
  willChange += dirtyRows.length;
  // 抽样预览前 3 条脏标题
  const sample = dirty.all(bookId);
  console.log(
    `\nbook ${bookId}: sections=${rows.length} dirty=${dirtyRows.length}`,
  );
  for (const s of sample) {
    const newTitle = s.chNo == null ? s.title : String(Math.trunc(Number(s.chNo)));
    console.log(`   ${s.title}  ->  ${newTitle}  (chNo=${s.chNo})`);
  }
}

console.log(`\nTOTAL sections in scope: ${total}, will normalize: ${willChange}`);

if (!apply) {
  console.log("\n[dry-run] 未改动任何数据。加 --apply 执行。");
  db.close();
  process.exit(0);
}

// 执行：只改脏标题 -> 章号数字
let updated = 0;
db.exec("BEGIN");
try {
  for (const bookId of NEW_BOOK_IDS) {
    const rows = db
      .prepare(
        `SELECT id, json_extract(data, '$.title') AS title,
                json_extract(data, '$._microfeed.chapterNo') AS chNo
         FROM items
         WHERE tcm_kind = 'section' AND book_id = ? AND status != 3`,
      )
      .all(bookId);
    for (const r of rows) {
      if (typeof r.title !== "string" || !(r.title.startsWith("第") && r.title.includes("条"))) {
        continue;
      }
      if (r.chNo == null) continue; // 无章号则不动（保持原样，避免丢失信息）
      const newTitle = String(Math.trunc(Number(r.chNo)));
      db.prepare(
        `UPDATE items SET data = json_set(data, '$.title', ?) WHERE id = ?`,
      ).run(newTitle, r.id);
      updated += 1;
    }
  }
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  console.error("FAILED, rolled back:", e.message);
  process.exit(1);
}
console.log(`\n[applied] normalized ${updated} section titles`);

// 验证：确认范围内已无脏标题
let remaining = 0;
for (const bookId of NEW_BOOK_IDS) {
  const n = db
    .prepare(
      `SELECT COUNT(*) AS n FROM items
       WHERE tcm_kind = 'section' AND book_id = ? AND status != 3
         AND json_extract(data, '$.title') LIKE '第%条%'`,
    )
    .get(bookId).n;
  remaining += n;
}
console.log(`remaining dirty titles in scope: ${remaining}`);
db.close();
