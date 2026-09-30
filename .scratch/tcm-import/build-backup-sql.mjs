// Read remote JSON dumps (no spawning) and rebuild INSERT OR REPLACE backups.
import { readFileSync, writeFileSync } from 'node:fs';

function rowsOf(file) {
  const arr = JSON.parse(readFileSync(file, 'utf8'));
  return arr[0]?.results ?? [];
}
function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
}
function dump(table, rows) {
  if (!rows.length) return { sql: '', n: 0 };
  // union of column names across rows
  const colsSet = new Set();
  for (const r of rows) for (const k of Object.keys(r)) colsSet.add(k);
  const c = [...colsSet];
  let sql = '';
  for (const row of rows) {
    const vals = c.map((k) => lit(row[k]));
    sql += `INSERT OR REPLACE INTO ${table} (${c.join(', ')}) VALUES (${vals.join(', ')});\n`;
  }
  return { sql, n: rows.length };
}

const i = dump('items', rowsOf('.scratch/tcm-import/remote-items.json'));
const ch = dump('channels', rowsOf('.scratch/tcm-import/remote-channels.json'));
writeFileSync(
  '.microfeed/backup-remote-pretcm-20260928.sql',
  `-- Logical backup of ctwh-881019-xyz-db (pre-TCM-import) ${new Date().toISOString()}\n` +
    `-- NOTE: excludes FTS5 virtual search table (regenerable from items by microfeed).\n` +
    `-- Restore: wrangler d1 execute ctwh-881019-xyz-db --remote --file=<this file>\n` +
    i.sql + ch.sql,
);
console.log('items:', i.n, 'channels:', ch.n, '-> .microfeed/backup-remote-pretcm-20260928.sql');
