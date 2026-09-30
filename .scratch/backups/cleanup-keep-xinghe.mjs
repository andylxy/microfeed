import { DatabaseSync } from 'node:sqlite';

const LOCAL = '.microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/miniflare-D1DatabaseObject/e60aa88374e950a08be5ad11bdf5fb22c7e803a0aa157cfb660080323535bcb8.sqlite';
const KEEP = 'J1jGJjUWeCz'; // 星河剑歌

const db = new DatabaseSync(LOCAL);

const before = {
  channels: db.prepare('SELECT COUNT(*) c FROM channels').get().c,
  items: db.prepare('SELECT COUNT(*) c FROM items').get().c,
};
console.log('BEFORE:', JSON.stringify(before));

db.exec('PRAGMA foreign_keys=OFF;');
db.exec('BEGIN;');
try {
  // 1) 删除挂在其他频道下的全部条目（book_id 为 NULL 的草稿自动保留）
  db.prepare("DELETE FROM items WHERE book_id <> ?").run(KEEP);
  // 2) 删除除 星河剑歌 外的全部频道
  db.prepare("DELETE FROM channels WHERE id <> ?").run(KEEP);
  // 3) 清空内容审计/派生表（保留 RBAC、认证、主题、页面、设置等配置）
  for (const t of ['ext_content_audit','ext_content_correction','ext_content_report','ext_content_review','item_search_metadata','item_create_idempotency']) {
    db.prepare('DELETE FROM "' + t + '"').run();
  }
  db.exec('COMMIT;');
  // 清 FTS 孤儿行：历史上 repour 的 INSERT OR REPLACE（recursive_triggers OFF）
  // 曾留下无 documents 对应的 FTS 行，触发器够不着，必须按 rowid 直删
  db.exec("DELETE FROM site_search_exact WHERE rowid NOT IN (SELECT id FROM site_search_documents);");
  db.exec("DELETE FROM site_search_title_trigram WHERE rowid NOT IN (SELECT id FROM site_search_documents);");
} catch (e) {
  db.exec('ROLLBACK;');
  console.error('CLEANUP FAILED, rolled back:', e.message);
  process.exit(2);
}

const after = {
  channels: db.prepare('SELECT COUNT(*) c FROM channels').get().c,
  items: db.prepare('SELECT COUNT(*) c FROM items').get().c,
  searchDocs: db.prepare('SELECT COUNT(*) c FROM site_search_documents').get().c,
  ftsExact: db.prepare('SELECT COUNT(*) c FROM site_search_exact').get().c,
};
console.log('AFTER :', JSON.stringify(after));

const keptCh = db.prepare("SELECT id, json_extract(data,'$.title') t FROM channels").all();
console.log('保留频道:', JSON.stringify(keptCh));
const keptItems = db.prepare("SELECT id, status, book_id, substr(json_extract(data,'$.title'),1,40) t FROM items ORDER BY book_id IS NULL, id").all();
console.log('保留条目 ' + keptItems.length + ' 条:');
keptItems.forEach(function(r){ console.log('  ' + JSON.stringify(r)); });

db.exec('VACUUM;');
console.log('VACUUM done, file size:', db.prepare("SELECT page_count*page_size AS b FROM pragma_page_count(), pragma_page_size()").get().b);
db.close();
console.log('CLEANUP_OK');
