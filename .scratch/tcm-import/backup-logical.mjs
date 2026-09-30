// Logical backup of the remote Cloudflare D1 (pre-TCM-import): dump items +
// channels (the irreplaceable novel content) as INSERT OR REPLACE statements.
// We cannot use `wrangler d1 export` because the DB has an FTS5 virtual table.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const WRANGLER = 'node_modules/wrangler/bin/wrangler.js';
const DB = 'ctwh-881019-xyz-db';
const OUT = '.microfeed/backup-remote-pretcm-20260928.sql';

function wjson(cmd) {
  const out = execFileSync(
    'node',
    [WRANGLER, 'd1', 'execute', DB, '--remote', '--json', '--command', cmd],
    { encoding: 'utf8', maxBuffer: 1 << 28 },
  );
  const arr = JSON.parse(out);
  return arr[0]?.results ?? [];
}
function cols(table) {
  return wjson(`SELECT name FROM pragma_table_info('${table}')`).map((r) => r.name);
}
function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
}
function dump(table) {
  const c = cols(table);
  const rows = wjson(`SELECT * FROM ${table}`);
  let sql = `-- backup ${table}: ${rows.length} rows\n`;
  for (const row of rows) {
    const vals = c.map((k) => lit(row[k]));
    sql += `INSERT OR REPLACE INTO ${table} (${c.join(', ')}) VALUES (${vals.join(', ')});\n`;
  }
  return { sql, n: rows.length };
}

const i = dump('items');
const ch = dump('channels');
writeFileSync(
  OUT,
  `-- Logical backup of ${DB} (pre-TCM-import) ${new Date().toISOString()}\n` +
    `-- NOTE: excludes FTS5 virtual search table (regenerable from items by microfeed).\n` +
    i.sql + ch.sql,
);
console.log('wrote', OUT);
console.log('  items:', i.n, ' channels:', ch.n);
