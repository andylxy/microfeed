/**
 * 批量修正 TCM 条目的「归属书本」（`_microfeed.bookId` + 镜像列 `book_id`）。
 *
 * 为什么需要它：导入脚本按容器频道给条目写 bookId（如中药 → tcmyao00001
 * 「本草」），本地实例若缺该频道，后台「归属书本」就只能显示原始 id。
 * 本脚本把指定 kind 下指向某个频道的条目整批改挂到另一个频道。
 *
 * 写入字段与应用 FeedDb._putItemToContentStatement 保持一致：
 *   data（JSON 内 `_microfeed.bookId`）、book_id 列、updated_at。
 * content_text / review_status / status / pub_date 与归属无关，一律不动。
 *
 * 用法：
 *   node .scratch/tcm-import/reassign-tcm-book.mjs <db-path> <tcm_kind> <from-book-id> <to-book-id> [--dry-run]
 */
import { DatabaseSync } from "node:sqlite";

const [dbPath, kind, fromBookId, toBookId, ...flags] = process.argv.slice(2);
const dryRun = flags.includes("--dry-run");

if (!dbPath || !kind || !fromBookId || !toBookId) {
  console.error(
    "usage: node reassign-tcm-book.mjs <db-path> <tcm_kind> <from-book-id> <to-book-id> [--dry-run]",
  );
  process.exit(2);
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 10000");

// 目标频道必须真实存在，否则改完只是换了一个悬空 id。
const target = db.prepare("SELECT id, status, data FROM channels WHERE id = ?").get(toBookId);
if (!target) {
  console.error(`目标频道不存在: ${toBookId}`);
  process.exit(1);
}
const targetTitle = JSON.parse(target.data)?.title ?? "";
console.log(`目标频道: ${toBookId} 「${targetTitle}」 status=${target.status}`);

const rows = db.prepare(
  "SELECT id, json_extract(data, '$.title') AS title FROM items " +
    "WHERE tcm_kind = ? AND json_extract(data, '$._microfeed.bookId') = ? " +
    "ORDER BY json_extract(data, '$._microfeed.no')",
).all(kind, fromBookId);

console.log(`待修正条目: ${rows.length} 条（${kind} @ ${fromBookId} → ${toBookId}）`);
if (rows.length === 0) process.exit(0);
if (dryRun) {
  for (const row of rows) console.log(`  [dry-run] ${row.id} ${row.title}`);
  process.exit(0);
}

const readData = db.prepare("SELECT data FROM items WHERE id = ?");
const update = db.prepare(
  "UPDATE items SET data = ?, book_id = ?, updated_at = ? WHERE id = ?",
);
const now = new Date().toISOString();

db.exec("BEGIN");
try {
  for (const row of rows) {
    const parsed = JSON.parse(readData.get(row.id).data);
    // 保持键顺序：直接赋值，不重建 _microfeed 对象。
    parsed._microfeed.bookId = toBookId;
    update.run(JSON.stringify(parsed), toBookId, now, row.id);
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

const after = db.prepare(
  "SELECT count(*) AS n FROM items WHERE tcm_kind = ? AND json_extract(data, '$._microfeed.bookId') = ?",
).get(kind, toBookId);
console.log(`完成：${toBookId} 下现有 ${after.n} 条 ${kind} 条目`);
