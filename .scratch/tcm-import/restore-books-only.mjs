// 按用户要求：清空全部内容后，只从"远程快照"恢复 星河剑歌 的书(频道)→卷/章节(chapter)→正文(section)。
// 排除：6 个小说频道、3 个容器频道(名词/方剂/本草)、方剂/中药/名词条目。
import {DatabaseSync} from "node:sqlite";

const LOCAL = ".microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/miniflare-D1DatabaseObject/e60aa88374e950a08be5ad11bdf5fb22c7e803a0aa157cfb660080323535bcb8.sqlite";
const BACKUP = ".scratch/backups/ctwh-local-post-remote-sync-20260929.sqlite";
const EXCLUDE_CHANNELS = new Set([
  "BkA1x9pQ2Lm", "BkE5b5tU6Pq", "BkB2y8qR3Mn", "BkC3z7rS4No", "BkF6c4uV7Qr", "BkD4a6sT5Op",
  "tcmfang0001", "tcmyao00001", "tcmterm0001",
]);

const db = new DatabaseSync(LOCAL);
const cnt = (t) => { try { return db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; } catch { return -1; } };
console.log("BEFORE channels/items:", cnt("channels"), "/", cnt("items"));

db.exec("PRAGMA foreign_keys=OFF;");
db.exec("BEGIN;");
try {
  for (const t of ["items","channels","pages","page_paths","item_create_idempotency","item_search_metadata","site_search_documents","site_search_metadata","site_search_exact","site_search_title_trigram"]) {
    db.exec(`DELETE FROM "${t}";`);
  }
  const bk = new DatabaseSync(BACKUP, {readOnly: true});
  const chans = bk.prepare("SELECT id,status,is_primary,data,created_at,updated_at,genre FROM channels").all();
  const insC = db.prepare("INSERT OR REPLACE INTO channels (id,status,is_primary,data,created_at,updated_at,genre) VALUES (?,?,?,?,?,?,?)");
  let nC = 0;
  for (const c of chans) {
    if (EXCLUDE_CHANNELS.has(c.id)) continue;
    insC.run(c.id, c.status, c.is_primary, c.data, c.created_at, c.updated_at, c.genre);
    nC += 1;
  }
  const items = bk.prepare("SELECT id,status,data,pub_date,created_at,updated_at,content_text,content_text_updated_at,content_text_revision,review_status,book_id,tcm_kind,tcm_parent_id FROM items").all();
  const insI = db.prepare("INSERT OR REPLACE INTO items (id,status,data,pub_date,created_at,updated_at,content_text,content_text_updated_at,content_text_revision,review_status,book_id,tcm_kind,tcm_parent_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
  let nI = 0;
  for (const it of items) {
    if (it.tcm_kind !== "chapter" && it.tcm_kind !== "section") continue;
    insI.run(it.id, it.status, it.data, it.pub_date, it.created_at, it.updated_at, it.content_text, it.content_text_updated_at, it.content_text_revision, it.review_status, it.book_id, it.tcm_kind, it.tcm_parent_id);
    nI += 1;
  }
  bk.close();
  console.log("restored channels:", nC, "items(chapter+section):", nI);
  db.exec("COMMIT;");
} catch (e) {
  db.exec("ROLLBACK;");
  console.error("RESTORE FAILED:", e.message);
  process.exit(2);
}
console.log("AFTER channels/items:", cnt("channels"), "/", cnt("items"));
const byKind = db.prepare("SELECT tcm_kind, COUNT(*) c FROM items GROUP BY tcm_kind ORDER BY tcm_kind").all();
console.log("items by kind:", byKind.map((r) => `${r.tcm_kind}=${r.c}`).join(" "));
const chans2 = db.prepare("SELECT id, json_extract(data,'$.title') t FROM channels ORDER BY t").all();
console.log("channels:", chans2.map((r) => `${r.id}(${r.t})`).join(", "));
db.close();
console.log("RESTORE_OK");
