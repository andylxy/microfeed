#!/usr/bin/env node
// 给任意小说书添加一章。前置：先停 manage dev（独占 sqlite）。
// 用法: node add-chapter.mjs --book "<频道ID|书名>" --title "第X卷 第Y章 标题" \
//         --volume "第X卷 卷名" --chapter-no N --pub-date "ISO时刻" --html 正文.html
// 书键双写、content_text 镜像、频道 wordCount 累加、FTS（触发器）自动处理。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
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

function htmlToText(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

// 统一成带毫秒的 UTC 格式：书页排序对 date_published 做字符串比较，
// 混用 "...:00Z" 与 "...:00.000Z" 会在同一时刻产生不稳定顺序。
function normalizeDate(input) {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) { console.error('pub-date 无法解析: ' + input); process.exit(1); }
  return d.toISOString();
}

function newId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(11);
  let id = '';
  for (const b of bytes) id += alphabet[b % alphabet.length];
  return id;
}

// 中文数字（一~九十九）→ 阿拉伯数字；核对标题「第Y章」与 --chapter-no 一致
function cnNum(s) {
  const digit = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (/^[0-9]+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  if (!/^(十|([一二三四五六七八九十]+))$/.test(s)) return null;
  const parts = s.split('十');
  const n = parts.length === 2
    ? (parts[0] ? digit[parts[0]] : 1) * 10 + (parts[1] ? digit[parts[1]] : 0)
    : digit[s];
  return Number.isFinite(n) && n > 0 ? n : null;
}

const args = parseArgs(process.argv.slice(2));
if (!args.book || !args.title || !args['pub-date'] || !args.html) {
  console.error('用法: node add-chapter.mjs --book "<频道ID|书名>" --title "第X卷 第Y章 标题" --volume "第X卷 卷名" --chapter-no N --pub-date "ISO时刻" --html 正文.html [--status 1|2] [--force] [--db 路径]');
  process.exit(1);
}
const chapterNo = Number(args['chapter-no'] ?? args.chapterNo);
if (!Number.isFinite(chapterNo)) { console.error('--chapter-no 必须是数字'); process.exit(1); }
const volume = (args.volume ?? '').trim();
if (!volume) console.warn('⚠️ 未提供 --volume：该章将进入「未归卷」桶（后台排最后）。');
const status = Number(args.status ?? 1);
if (![1, 2].includes(status)) { console.error('--status 只支持 1(发布) 或 2(草稿)'); process.exit(1); }
const pubDate = normalizeDate(args['pub-date']);
const html = readFileSync(args.html, 'utf8');
const text = htmlToText(html);
const wordCount = text.replace(/\s/g, '').length;
const dbPath = args.db ?? DEFAULT_DB;

const db = new DatabaseSync(dbPath);

// 解析书：先按频道 ID，再按书名精确匹配
let book = db.prepare('SELECT id, data FROM channels WHERE id=?').get(args.book);
if (!book) {
  const candidates = db.prepare("SELECT id, data FROM channels WHERE json_extract(data,'$.title')=?").all(args.book);
  if (candidates.length === 1) book = candidates[0];
  else if (candidates.length === 0) {
    console.error('✋ 书不存在：' + args.book + '。先用 add-book.mjs 建书，或核对 --book（频道 ID 或完整书名）。');
    db.close(); process.exit(2);
  } else {
    console.error('✋ 书名重名（' + candidates.length + ' 本），请改用频道 ID：');
    candidates.forEach(function(c){ console.error('   ' + c.id + ' ' + JSON.parse(c.data).title); });
    db.close(); process.exit(2);
  }
}
const BOOK_ID = book.id;
const bookData = JSON.parse(book.data);
const bookTitle = bookData.title;
console.log('目标书: ' + BOOK_ID + '《' + bookTitle + '》');

// 闸 0：TCM 书不能用小说方式加章。TCM 的卷/章是结构化的
// （tcm_kind='chapter' 作卷、tcm_kind='section' 作卷内章，归属靠 tcm_parent_id），
// 卷面板按此实时派生且只读；本脚本写的 volume/chapterNo 标签会被 TCM 分支忽略，
// 新章只会掉进「未分卷」孤儿桶。
const tcmProbe = db.prepare(
  'SELECT 1 AS one FROM items WHERE book_id=? AND tcm_kind IS NOT NULL LIMIT 1'
).get(BOOK_ID);
if (tcmProbe && !args.force) {
  console.error('✋ 拒绝：《' + bookTitle + '》是 TCM 结构化书（含 tcm_kind 条目）。');
  console.error('   该书的卷/章由 tcm_kind + tcm_parent_id 决定，卷面板据此实时派生且可编辑；');
  console.error('   但本脚本只写 volume/chapterNo 标签，与 TCM 结构不匹配（编辑落点应是 tcm_parent_id）→ 新章落进「未分卷」桶。');
  console.error('   TCM 内容请走 scripts/import-ctwh/ 导入，或在后台卷面板用「归入卷」操作。确知后果可加 --force。');
  db.close();
  process.exit(2);
}

db.exec('BEGIN;');
try {
  // 闸 1：顺序——新章 pub_date 必须晚于本书现有最新一章
  const latest = db.prepare(
    "SELECT id, pub_date, json_extract(data,'$.title') t FROM items WHERE book_id=? AND status=1 ORDER BY pub_date DESC, id LIMIT 1"
  ).get(BOOK_ID);
  if (latest && pubDate <= latest.pub_date && !args.force) {
    console.error('✋ 拒绝：pub_date(' + pubDate + ') 不晚于本书最新一章「' + latest.t + '」(' + latest.pub_date + ')。加 --force 强制。');
    db.close(); process.exit(2);
  }
  // 闸 2：同卷章号唯一
  if (volume) {
    const dup = db.prepare(
      "SELECT id, json_extract(data,'$.title') t FROM items WHERE book_id=? AND status!=3 " +
      "AND json_extract(data,'$._microfeed.volume')=? AND json_extract(data,'$._microfeed.chapterNo')=?"
    ).get(BOOK_ID, volume, chapterNo);
    if (dup && !args.force) {
      console.error('✋ 拒绝：本书卷「' + volume + '」已存在 chapterNo=' + chapterNo + ' 的章「' + dup.t + '」(' + dup.id + ')。加 --force 强制。');
      db.close(); process.exit(2);
    }
  }
  // 检查：标题「第Y章」应与 --chapter-no 一致
  const m = args.title.match(/第([0-9一二三四五六七八九十]{1,3})章/);
  if (m) {
    const titleNo = cnNum(m[1]);
    if (titleNo != null && titleNo !== chapterNo) {
      console.warn('⚠️ 标题章号「第' + m[1] + '章」(=' + titleNo + ') 与 --chapter-no ' + chapterNo + ' 不一致，请确认。');
    }
  }

  const id = newId();
  const now = new Date().toISOString();
  const data = {
    title: args.title,
    description: html,
    _microfeed: {
      volume,
      chapterNo,
      order: chapterNo,
      wordCount,
      reviewStatus: 'approved',
      bookId: BOOK_ID, // 书键双写之二（标签侧）；之一是 items.book_id 列
    },
  };
  db.prepare(
    "INSERT INTO items (id,status,data,pub_date,created_at,updated_at,content_text,content_text_updated_at,content_text_revision,review_status,book_id) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  ).run(id, status, JSON.stringify(data), pubDate, now, now, text, now, 1, 'approved', BOOK_ID);

  // 频道总字数累加
  bookData._microfeed = bookData._microfeed || {};
  const before = Number(bookData._microfeed.wordCount) || 0;
  bookData._microfeed.wordCount = before + wordCount;
  db.prepare('UPDATE channels SET data=?, updated_at=? WHERE id=?').run(JSON.stringify(bookData), now, BOOK_ID);
  console.log('频道 wordCount: ' + before + ' -> ' + bookData._microfeed.wordCount);
  db.exec('COMMIT;');

  const total = db.prepare('SELECT COUNT(*) c FROM items WHERE book_id=?').get(BOOK_ID).c;
  const docs = db.prepare('SELECT COUNT(*) c FROM site_search_documents WHERE content_type=? AND content_id=?').get('item', id).c;
  console.log('✅ 已添加: ' + id + ' 「' + args.title + '」 status=' + status + ' pub_date=' + pubDate + ' wordCount=' + wordCount);
  console.log('   本书条目总数: ' + total + '；新章搜索文档: ' + docs + (docs === 1 ? '（触发器已建索引）' : '（⚠️ 未建，检查触发器）'));
} catch (e) {
  db.exec('ROLLBACK;');
  console.error('写入失败，已回滚:', e.message);
  db.close(); process.exit(2);
}
db.close();
