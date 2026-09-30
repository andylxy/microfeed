// Read-only inspection of the local TCM miniflare D1 (no writes).
import { DatabaseSync } from 'node:sqlite';

const DB ='.microfeed/instances/ctwh-881019-xyz/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/e60aa88374e950a08be5ad11bdf5fb22c7e803a0aa157cfb660080323535bcb8.sqlite';

const db = new DatabaseSync(DB, { readOnly: true });

console.log('=== TCM item counts by kind ===');
for (const r of db.prepare(`SELECT tcm_kind, COUNT(*) c FROM items WHERE tcm_kind IS NOT NULL GROUP BY tcm_kind ORDER BY c DESC`).all()) {
  console.log(`  ${r.tcm_kind}\t${r.c}`);
}
console.log('=== items total / with book_id ===');
console.log(JSON.stringify(db.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN book_id IS NOT NULL THEN 1 ELSE 0 END) withBook FROM items`).get()));

console.log('=== book channels (channels whose data has tcmContainer absent but has items) ===');
// book channels = channels that host chapter items (book_id points to them)
const books = db.prepare(`
  SELECT c.id, json_extract(c.data,'$.title') title, COUNT(i.id) itemCount
  FROM channels c
  JOIN items i ON i.book_id = c.id
  WHERE i.tcm_kind IS NOT NULL
  GROUP BY c.id
  ORDER BY itemCount DESC
  LIMIT 20
`).all();
for (const b of books) console.log(`  ${b.id}\t${b.title}\titems=${b.itemCount}`);

console.log('=== container channels ===');
for (const r of db.prepare(`SELECT id, json_extract(data,'$.title') title, json_extract(data,'$._microfeed.tcmContainer') tc FROM channels WHERE json_extract(data,'$._microfeed.tcmContainer') IS NOT NULL`).all()) {
  console.log(`  ${r.id}\t${r.title}\ttcmContainer=${r.tc}`);
}

console.log('=== items column list ===');
console.log(db.prepare(`PRAGMA table_info(items)`).all().map(c => c.name).join(', '));
console.log('=== channels column list ===');
console.log(db.prepare(`PRAGMA table_info(channels)`).all().map(c => c.name).join(', '));

console.log('=== sample: a book with chapters+sections to pick for small import ===');
const pick = books[0];
if (pick) {
  const chaps = db.prepare(`SELECT id, json_extract(data,'$.title') title FROM items WHERE tcm_kind='chapter' AND book_id=? ORDER BY json_extract(data,'$._microfeed.no') LIMIT 5`).all(pick.id);
  console.log(`book ${pick.id} (${pick.title}) chapters sample:`);
  for (const ch of chaps) console.log(`    ${ch.id}\t${ch.title}`);
  if (chaps.length) {
    const chapIds = chaps.map(c => c.id);
    const sections = db.prepare(`SELECT id, json_extract(data,'$.title') title FROM items WHERE tcm_kind='section' AND tcm_parent_id IN (${chapIds.map(()=>'?').join(',')}) LIMIT 5`).all(...chapIds);
    console.log('  sections sample:');
    for (const s of sections) console.log(`    ${s.id}\t${s.title}`);
  }
}
db.close();
console.log('DONE');
