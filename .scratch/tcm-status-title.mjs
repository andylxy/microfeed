/**
 * 1) Flip imported TCM 条文 (sections) from unlisted(4) to published(1).
 * 2) Shorten their generated titles ("第1001000720条・杂病例第五") down to the
 *    chapter number the item already carries ("20") — inside a volume group the
 *    number is what identifies a 条文, and the long form was unreadable.
 *
 * Idempotent. Only touches tcm_kind='section' rows.
 */
import { DatabaseSync } from "node:sqlite";

const DB =
  ".microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/miniflare-D1DatabaseObject/e60aa88374e950a08be5ad11bdf5fb22c7e803a0aa157cfb660080323535bcb8.sqlite";
const db = new DatabaseSync(DB);

const before = db
  .prepare(
    `SELECT status, COUNT(*) AS n FROM items WHERE tcm_kind = 'section' GROUP BY status`,
  )
  .all();
console.log("section status before:", JSON.stringify(before));

db.exec("BEGIN");
try {
  // 1) status -> published
  const s = db
    .prepare(
      `UPDATE items SET status = 1 WHERE tcm_kind = 'section' AND status != 1`,
    )
    .run();
  console.log("status updated rows:", s.rowsWritten ?? "(n/a)");

  // 2) title -> chapter number
  const t = db
    .prepare(
      `UPDATE items
       SET data = json_set(data, '$.title',
         CAST(json_extract(data, '$._microfeed.chapterNo') AS TEXT))
       WHERE tcm_kind = 'section'
         AND json_extract(data, '$._microfeed.chapterNo') IS NOT NULL`,
    )
    .run();
  console.log("title updated rows:", t.rowsWritten ?? "(n/a)");

  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  console.error("FAILED, rolled back:", e.message);
  process.exit(1);
}

const after = db
  .prepare(
    `SELECT status, COUNT(*) AS n FROM items WHERE tcm_kind = 'section' GROUP BY status`,
  )
  .all();
console.log("section status after:", JSON.stringify(after));

const sample = db
  .prepare(
    `SELECT id, status, json_extract(data, '$.title') AS title,
            json_extract(data, '$._microfeed.chapterNo') AS chNo,
            json_extract(data, '$._microfeed.volume') AS vol
     FROM items WHERE id IN ('mWPC6jJcIdX','0tr3l7UHuUP')`,
  )
  .all();
console.log("samples:", JSON.stringify(sample, null, 1));

const titleLen = db
  .prepare(
    `SELECT MIN(LENGTH(json_extract(data,'$.title'))) AS minLen,
            MAX(LENGTH(json_extract(data,'$.title'))) AS maxLen
     FROM items WHERE tcm_kind = 'section'`,
  )
  .all();
console.log("section title lengths:", JSON.stringify(titleLen));

const kinds = db
  .prepare(`SELECT tcm_kind, status, COUNT(*) AS n FROM items GROUP BY tcm_kind, status`)
  .all();
console.log("all by kind/status:", JSON.stringify(kinds));

db.close();
