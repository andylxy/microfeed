import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const dbPath = 'D:/git/AiCode/microfeed/.microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/miniflare-D1DatabaseObject/e60aa88374e950a08be5ad11bdf5fb22c7e803a0aa157cfb660080323535bcb8.sqlite';
const db = new DatabaseSync(dbPath);

console.log('=== items table schema ===');
const cols = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='items'").get();
console.log(cols?.sql);

const id = 'UN8KV9xhXQH';
const row = db.prepare("SELECT id, book_id, tcm_kind, json_extract(data,'$._microfeed') AS mf, json_extract(data,'$.title') AS title FROM items WHERE id=?").get(id);
if (!row) {
  console.log('NOT FOUND', id);
  // try partial
  const like = db.prepare("SELECT id, book_id, tcm_kind FROM items WHERE id LIKE ? LIMIT 20").all(id.slice(0,6)+'%');
  console.log('LIKE matches:', JSON.stringify(like, null, 2));
  process.exit(0);
}
console.log('=== item', id, '===');
console.log('book_id:', row.book_id, 'tcm_kind:', row.tcm_kind, 'title:', row.title);
const mf = JSON.parse(row.mf || '{}');
console.log('=== _microfeed keys ===', Object.keys(mf));
console.log('=== fangYaoList ===');
const fy = mf.fangYaoList || [];
console.log('fangYaoList length:', fy.length);
console.log(JSON.stringify(fy, null, 2));
