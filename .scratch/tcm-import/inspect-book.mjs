import { DatabaseSync } from 'node:sqlite';

const DB = '.microfeed/instances/ctwh-881019-xyz/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/e60aa88374e950a08be5ad11bdf5fb22c7e803a0aa157cfb660080323535bcb8.sqlite';
const db = new DatabaseSync(DB, { readOnly: true });

const BOOK = 'XNK0VFX39Xv'; // 伤寒论・(人纪)
console.log('=== book channel row ===');
const ch = db.prepare(`SELECT id, status, genre, data FROM channels WHERE id=?`).get(BOOK);
console.log('status=', ch.status, 'genre=', ch.genre);
console.log('data=', ch.data);

console.log('=== categories present ===');
for (const r of db.prepare(`SELECT id, name, slug FROM ext_category`).all()) console.log('  ', r.id, r.name, r.slug);

console.log('=== chapters of book ===');
const chaps = db.prepare(`SELECT id, json_extract(data,'$._microfeed.section') sec, json_extract(data,'$._microfeed.sourceBookId') sb, json_extract(data,'$.title') t FROM items WHERE tcm_kind='chapter' AND book_id=? AND status=1 ORDER BY sec LIMIT 40`).all(BOOK);
console.log('chapter count (status=1):', chaps.length);
console.log('sourceBookId values among chapters:', [...new Set(chaps.map(c=>c.sb))]);
const FIRST_SB = chaps[0]?.sb;
console.log('first chapter sourceBookId =', FIRST_SB);

console.log('=== fang with that sourceBookId ===');
const fang = db.prepare(`SELECT id, json_extract(data,'$._microfeed.sourceBookId') sb, json_extract(data,'$.title') t FROM items WHERE tcm_kind='fang' AND status=1 AND json_extract(data,'$._microfeed.sourceBookId')=? LIMIT 5`).all(FIRST_SB);
console.log('fang count for sourceBookId', FIRST_SB, ':', fang.length);
for (const f of fang) console.log('   ', f.id, f.t);

console.log('=== yao count (status=1) ===', db.prepare(`SELECT COUNT(*) c FROM items WHERE tcm_kind='yao' AND status=1`).get().c);
console.log('=== term count (status=1) ===', db.prepare(`SELECT COUNT(*) c FROM items WHERE tcm_kind='term' AND status=1`).get().c);
console.log('=== sections with bieMing (for aliases) count ===', db.prepare(`SELECT COUNT(*) c FROM items WHERE tcm_kind='section' AND status!=3 AND json_extract(data,'$._microfeed.bieMing')!=''`).get().c);
db.close();
console.log('DONE');
