// Extract a SMALL, coherent TCM subset from the local miniflare D1 into a .sql
// file for remote load. Read-only on the local DB.
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';

const DB = '.microfeed/instances/ctwh-881019-xyz/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/e60aa88374e950a08be5ad11bdf5fb22c7e803a0aa157cfb660080323535bcb8.sqlite';
const OUT = '.scratch/tcm-import/small-data.sql';

const db = new DatabaseSync(DB, { readOnly: true });

function cols(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}
function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  // string: escape single quotes
  return `'${String(v).replace(/'/g, "''")}'`;
}
function emit(table, columns, rows) {
  let out = '';
  for (const row of rows) {
    const vals = columns.map((c) => lit(row[c]));
    out += `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${vals.join(', ')});\n`;
  }
  return out;
}

const BOOK = 'XNK0VFX39Xv'; // 伤寒论・(人纪) — genre=cat_renji01 (shows in GetNav)

// 1) book channel
const chCols = cols('channels');
const channel = db.prepare(`SELECT * FROM channels WHERE id=?`).all(BOOK);

// 2) chapters of the book
const itCols = cols('items');
const chapters = db.prepare(
  `SELECT * FROM items WHERE tcm_kind='chapter' AND book_id=? AND status=1`,
).all(BOOK);
const chapIds = chapters.map((c) => c.id);

// 3) a few sections under those chapters
const sections = chapIds.length
  ? db.prepare(
      `SELECT * FROM items WHERE tcm_kind='section' AND tcm_parent_id IN (${chapIds.map(() => '?').join(',')}) AND status!=3 LIMIT 10`,
    ).all(...chapIds)
  : [];

// 4) fang for the displayed book (coherent nav→chapter→fang flow); fall back to
//    the sourceBookId with the most fang if this book has none.
function fangFor(sb) {
  return db.prepare(
    `SELECT * FROM items WHERE tcm_kind='fang' AND status=1 AND json_extract(data,'$._microfeed.sourceBookId')=? LIMIT 10`,
  ).all(sb);
}
let fangSourceBookId = BOOK;
let fang = fangFor(fangSourceBookId);
if (fang.length === 0) {
  const top = db.prepare(
    `SELECT json_extract(data,'$._microfeed.sourceBookId') sb FROM items WHERE tcm_kind='fang' AND status=1 AND json_extract(data,'$._microfeed.sourceBookId')!='' GROUP BY sb ORDER BY COUNT(*) DESC LIMIT 1`,
  ).get();
  fangSourceBookId = top?.sb ?? '';
  fang = fangSourceBookId ? fangFor(fangSourceBookId) : [];
}

// 5) a few yao + term
const yao = db.prepare(`SELECT * FROM items WHERE tcm_kind='yao' AND status=1 ORDER BY json_extract(data,'$._microfeed.no') LIMIT 10`).all();
const term = db.prepare(`SELECT * FROM items WHERE tcm_kind='term' AND status=1 ORDER BY json_extract(data,'$._microfeed.no') LIMIT 5`).all();

let sql = `-- Small TCM sample extracted ${new Date().toISOString()}\n`;
sql += `-- book channel ${BOOK}, fang sourceBookId=${fangSourceBookId}\n`;
sql += emit('channels', chCols, channel);
sql += emit('items', itCols, [...chapters, ...sections, ...fang, ...yao, ...term]);

writeFileSync(OUT, sql);
db.close();

console.log('wrote', OUT);
console.log('  channels:', channel.length);
console.log('  chapters:', chapters.length);
console.log('  sections:', sections.length);
console.log('  fang (sourceBookId=' + fangSourceBookId + '):', fang.length);
console.log('  yao:', yao.length);
console.log('  term:', term.length);
console.log('  TOTAL items rows:', chapters.length + sections.length + fang.length + yao.length + term.length);
