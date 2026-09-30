/**
 * Backfill `_microfeed.volume` + `_microfeed.chapterNo` for TCM sections.
 *
 * TCM structure authority stays `tcm_parent_id` (the volume board derives
 * volume membership live from it). This only writes the *display* metadata the
 * item editor reads, so the editor shows the real volume name instead of a
 * blank field. Safe to re-run (idempotent).
 */
import { DatabaseSync } from "node:sqlite";

const DB =
  ".microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/miniflare-D1DatabaseObject/e60aa88374e950a08be5ad11bdf5fb22c7e803a0aa157cfb660080323535bcb8.sqlite";
const db = new DatabaseSync(DB);

const chapters = db
  .prepare(
    `SELECT id, json_extract(data, '$.title') AS title
     FROM items WHERE tcm_kind = 'chapter' AND status != 3
     ORDER BY json_extract(data, '$._microfeed.section'), id`,
  )
  .all();

console.log("chapters:", chapters.length);

let sections = 0;
const update = db.prepare(
  `UPDATE items SET data = json_set(json_set(data, '$._microfeed.volume', ?), '$._microfeed.chapterNo', ?)
   WHERE id = ?`,
);

db.exec("BEGIN");
try {
  for (const ch of chapters) {
    const rows = db
      .prepare(
        `SELECT id FROM items
         WHERE tcm_parent_id = ? AND tcm_kind = 'section' AND status != 3
         ORDER BY json_extract(data, '$._microfeed.receiptNo'), id`,
      )
      .all(ch.id);
    rows.forEach((row, i) => {
      update.run(ch.title ?? "未命名篇章", i + 1, row.id);
      sections += 1;
    });
  }
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  console.error("FAILED, rolled back:", e.message);
  process.exit(1);
}

console.log("backfilled sections:", sections);

const check = db
  .prepare(
    `SELECT id, json_extract(data, '$._microfeed.volume') AS vol,
            json_extract(data, '$._microfeed.chapterNo') AS chNo
     FROM items WHERE id = '0tr3l7UHuUP'`,
  )
  .all();
console.log("sample 0tr3l7UHuUP:", JSON.stringify(check));

const stats = db
  .prepare(
    `SELECT CASE WHEN tcm_kind IS NOT NULL THEN 'tcm' ELSE 'non-tcm' END AS kind,
            COUNT(*) AS n,
            SUM(CASE WHEN json_extract(data, '$._microfeed.volume') IS NOT NULL THEN 1 ELSE 0 END) AS hasVolume
     FROM items GROUP BY kind`,
  )
  .all();
console.log("after backfill:", JSON.stringify(stats));

db.close();
