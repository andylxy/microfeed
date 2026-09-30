import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const LOCAL = '.microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/miniflare-D1DatabaseObject/e60aa88374e950a08be5ad11bdf5fb22c7e803a0aa157cfb660080323535bcb8.sqlite';
const SQL_PATH = '.scratch/backups/remote-ctwh-data-nosearchdocs.sql';
const TABLES_PATH = '.scratch/backups/realtables.txt';

const tables = readFileSync(TABLES_PATH, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
const sql = readFileSync(SQL_PATH, 'utf8');

const db = new DatabaseSync(LOCAL);
db.exec('PRAGMA foreign_keys=OFF;');

const before = {
  channels: db.prepare('SELECT COUNT(*) c FROM channels').get().c,
  items: db.prepare('SELECT COUNT(*) c FROM items').get().c,
};

db.exec('BEGIN;');
try {
  for (const t of tables) {
    db.exec(`DELETE FROM "${t}";`);
  }
  db.exec(sql);
  // mark search as ready (FTS already rebuilt by triggers during inserts)
  db.exec(`INSERT INTO site_search_metadata (id, ready, normalized_at) VALUES (1, 1, NULL) ON CONFLICT(id) DO UPDATE SET ready=1;`);
  db.exec('COMMIT;');
} catch (e) {
  db.exec('ROLLBACK;');
  console.error('IMPORT FAILED, rolled back. Error:', e.message);
  process.exit(2);
}

const after = {
  channels: db.prepare('SELECT COUNT(*) c FROM channels').get().c,
  items: db.prepare('SELECT COUNT(*) c FROM items').get().c,
  searchDocs: db.prepare('SELECT COUNT(*) c FROM site_search_documents').get().c,
  ftsExact: db.prepare('SELECT COUNT(*) c FROM site_search_exact').get().c,
  ftsTrigram: db.prepare('SELECT COUNT(*) c FROM site_search_title_trigram').get().c,
};
const primary = db.prepare("SELECT id, json_extract(data,'$.title') title, status FROM channels WHERE json_extract(data,'$.title')='星河剑歌'").all();
console.log('BEFORE:', JSON.stringify(before));
console.log('AFTER :', JSON.stringify(after));
console.log('星河剑歌 channel(s):', JSON.stringify(primary));
const sample = db.prepare("SELECT id, json_extract(data,'$.title') title FROM channels WHERE json_extract(data,'$.title') LIKE '%伤寒杂病论%'").all();
console.log('TCM sample:', JSON.stringify(sample));
db.close();
console.log('SYNC_OK');
