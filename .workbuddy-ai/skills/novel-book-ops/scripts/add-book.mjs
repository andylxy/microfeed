#!/usr/bin/env node
// 新建一本小说书（channels 行）。前置：先停 manage dev（独占 sqlite）。
// 数据结构以《星河剑歌》(J1jGJjUWeCz) 实际频道 JSON 为参照实现。
// 用法: node add-book.mjs --title "书名" [--description 简介] [--author 作者] \
//         [--genre <分类ID|分类名>] [--tags "标签1,标签2"] \
//         [--serial-status serializing|finished] [--sign-status signed|unsigned] [--force]
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

const DEFAULT_DB = '.microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/miniflare-D1DatabaseObject/e60aa88374e950a08be5ad11bdf5fb22c7e803a0aa157cfb660080323535bcb8.sqlite';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) { console.error('未知参数: ' + key); process.exit(1); }
    if (key === '--force') { args.force = true; continue; }
    args[key.slice(2)] = argv[++i];
  }
  return args;
}

function newId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(11);
  let id = '';
  for (const b of bytes) id += alphabet[b % alphabet.length];
  return id;
}

const args = parseArgs(process.argv.slice(2));
if (!args.title) {
  console.error('用法: node add-book.mjs --title "书名" [--description 简介] [--author 作者] [--genre <分类ID|分类名>] [--tags "a,b"] [--serial-status serializing|finished] [--sign-status signed|unsigned] [--force] [--db 路径]');
  process.exit(1);
}
const serialStatus = args['serial-status'] ?? 'serializing';
if (!['serializing', 'finished'].includes(serialStatus)) { console.error('--serial-status 只支持 serializing|finished'); process.exit(1); }
const signStatus = args['sign-status'] ?? 'signed';
if (!['signed', 'unsigned'].includes(signStatus)) { console.error('--sign-status 只支持 signed|unsigned'); process.exit(1); }
const tags = (args.tags ?? '').split(',').map(function(s){ return s.trim(); }).filter(Boolean);

const db = new DatabaseSync(args.db ?? DEFAULT_DB);

// 闸：同名书拒绝（防误建），--force 才放行
const dup = db.prepare("SELECT id, status FROM channels WHERE json_extract(data,'$.title')=?").all(args.title);
if (dup.length > 0 && !args.force) {
  console.error('✋ 拒绝：已存在同名书 ' + dup.map(function(d){ return d.id + '(status=' + d.status + ')'; }).join(', ') + '。加 --force 强制，或改用该 id 直接加章。');
  db.close(); process.exit(2);
}

// 分类解析：接受分类 ID 或分类名；找不到则置空并警告
let genre = null;
if (args.genre) {
  const cat = db.prepare('SELECT id, name FROM ext_category WHERE id=? OR name=?').get(args.genre, args.genre);
  if (cat) { genre = cat.id; console.log('分类: ' + cat.id + ' ' + cat.name); }
  else console.warn('⚠️ 分类「' + args.genre + '」不存在（ext_category 无此 id/名），genre 置空；可稍后在后台补。');
}

const id = newId();
const now = new Date().toISOString();
// 数据结构参照《星河剑歌》实际频道 JSON（参考实现）
const data = {
  title: args.title,
  description: args.description ?? '',
  authors: args.author ? [{ name: args.author }] : [],
  language: 'zh-CN',
  ...(genre ? { genre } : {}),
  _microfeed: {
    serialStatus,
    signStatus,
    ...(genre ? { genre } : {}),
    tags,
    wordCount: 0,
  },
};

db.exec('BEGIN;');
try {
  db.prepare('INSERT INTO channels (id,status,is_primary,data,created_at,updated_at,genre) VALUES (?,?,?,?,?,?,?)')
    .run(id, 1, 0, JSON.stringify(data), now, now, genre);
  db.exec('COMMIT;');
} catch (e) {
  db.exec('ROLLBACK;');
  console.error('写入失败，已回滚:', e.message);
  db.close(); process.exit(2);
}

console.log('✅ 已建书: ' + id + '《' + args.title + '》');
console.log('   加第一章: node add-chapter.mjs --book ' + id + ' --title "第一章 ×××" [--volume "第一卷 ×××"] --chapter-no 1 --pub-date "ISO时刻" --html 正文.html');
db.close();
