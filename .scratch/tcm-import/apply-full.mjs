import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const LOCAL = '.microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/miniflare-D1DatabaseObject/e60aa88374e950a08be5ad11bdf5fb22c7e803a0aa157cfb660080323535bcb8.sqlite';
const BACKUP = '.scratch/backups/ctwh-local-post-remote-sync-20260929.sqlite';
const OUT = '.scratch/tcm-import/out';
const PRIMARY_IDS = ['tcmfang0001', 'tcmyao00001', 'tcmterm0001', 'J1jGJjUWeCz'];

const db = new DatabaseSync(LOCAL);
const cnt = (t) => { try { return db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; } catch { return -1; } };
console.log('BEFORE channels/items:', cnt('channels'), '/', cnt('items'));

db.exec('PRAGMA foreign_keys=OFF;');
db.exec('BEGIN;');
try {
  db.exec(readFileSync(join(OUT, 'tcm-channels.sql'), 'utf8'));
  const batches = readdirSync(OUT).filter((f) => /^tcm-batch-\d+\.sql$/.test(f)).sort();
  for (const f of batches) db.exec(readFileSync(join(OUT, f), 'utf8'));
  const bk = new DatabaseSync(BACKUP, { readOnly: true });
  const extra = bk.prepare(`SELECT id,status,is_primary,data,created_at,updated_at,genre FROM channels WHERE id IN (${PRIMARY_IDS.map(() => '?').join(',')})`).all(...PRIMARY_IDS);
  bk.close();
  const ins = db.prepare('INSERT OR REPLACE INTO channels (id,status,is_primary,data,created_at,updated_at,genre) VALUES (?,?,?,?,?,?,?)');
  for (const r of extra) ins.run(r.id, r.status, r.is_primary, r.data, r.created_at, r.updated_at, r.genre);
  console.log('restored container/primary channels:', extra.map((r) => r.id).join(','));
  db.exec('COMMIT;');
} catch (e) {
  db.exec('ROLLBACK;');
  console.error('APPLY FAILED:', e.message);
  process.exit(2);
}
console.log('AFTER channels/items:', cnt('channels'), '/', cnt('items'));
const byKind = db.prepare('SELECT tcm_kind, COUNT(*) c FROM items GROUP BY tcm_kind ORDER BY tcm_kind').all();
console.log('items by kind:', byKind.map((r) => `${r.tcm_kind}=${r.c}`).join(' '));
const chans = db.prepare("SELECT id, json_extract(data,'$.title') t FROM channels ORDER BY id").all();
console.log('channels:', chans.map((r) => `${r.id}(${r.t})`).join(', '));
db.close();
console.log('APPLY_OK');
