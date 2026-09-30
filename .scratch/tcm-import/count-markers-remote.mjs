import { readFileSync } from 'node:fs';
const f = process.argv[2];
const raw = readFileSync(f, 'utf8');
const arr = JSON.parse(raw);
const rows = arr[0].results;
const re = /\$[A-Za-z]\{/g;
let total = 0;
const byKind = {};
for (const r of rows) {
  const d = r.d;
  if (typeof d === 'string') {
    const m = d.match(re);
    if (m) total += m.length;
  }
}
console.log('remote description marker count =', total, '(expected 13342)');
console.log('rows read =', rows.length);
