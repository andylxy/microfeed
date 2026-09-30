/**
 * Normalise TCM 条文: `chapterNo` came back as a float for some rows (11.0),
 * which leaked into the shortened title ("11.0"). Force both to integers.
 */
import { DatabaseSync } from "node:sqlite";

const DB =
  ".microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/miniflare-D1DatabaseObject/e60aa88374e950a08be5ad11bdf5fb22c7e803a0aa157cfb660080323535bcb8.sqlite";
const db = new DatabaseSync(DB);

db.exec("BEGIN");
try {
  db.prepare(
    `UPDATE items
     SET data = json_set(data, '$._microfeed.chapterNo',
       CAST(json_extract(data, '$._microfeed.chapterNo') AS INTEGER))
     WHERE tcm_kind = 'section'
       AND json_extract(data, '$._microfeed.chapterNo') IS NOT NULL`,
  ).run();

  db.prepare(
    `UPDATE items
     SET data = json_set(data, '$.title',
       CAST(CAST(json_extract(data, '$._microfeed.chapterNo') AS INTEGER) AS TEXT))
     WHERE tcm_kind = 'section'
       AND json_extract(data, '$._microfeed.chapterNo') IS NOT NULL`,
  ).run();

  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  console.error("FAILED, rolled back:", e.message);
  process.exit(1);
}

const samples = db
  .prepare(
    `SELECT id, status, json_extract(data, '$.title') AS title,
            json_extract(data, '$._microfeed.chapterNo') AS chNo,
            json_extract(data, '$._microfeed.volume') AS vol
     FROM items WHERE id IN ('mWPC6jJcIdX', '0tr3l7UHuUP')`,
  )
  .all();
console.log("samples:", JSON.stringify(samples, null, 1));

const lens = db
  .prepare(
    `SELECT MIN(LENGTH(json_extract(data, '$.title'))) AS minLen,
            MAX(LENGTH(json_extract(data, '$.title'))) AS maxLen
     FROM items WHERE tcm_kind = 'section'`,
  )
  .all();
console.log("title lengths:", JSON.stringify(lens));

const dotted = db
  .prepare(
    `SELECT COUNT(*) AS n FROM items
     WHERE tcm_kind = 'section'
       AND json_extract(data, '$.title') LIKE '%.0'`,
  )
  .all();
console.log("titles still ending .0:", dotted[0].n);

db.close();
