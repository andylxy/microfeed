/**
 * ctwh 源数据「匹配关系」全量审计（工单：重新分析匹配关系）。
 *
 * 目的：回答「书 → 篇章 → 条文」三级关系在源库里到底长什么样，以及有没有
 * 跨书错挂 / 孤儿 / 编号体系异常。只读，不写任何库。
 *
 * 用法：node --import tsx scripts/import-ctwh/analyze-relations.mts
 */
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {iterInsertRows, rowValue, rowText} from "./parse";

const ROOT = resolve(import.meta.dirname, "../..");
const DUMP = (name: string) => `${ROOT}/ctwh/${name}.sql`;

function load(file: string) {
  return [...iterInsertRows(readFileSync(file, "utf8"))];
}

/** Find a column index case-insensitively; -1 when absent. */
function col(row: {columns: string[]}, ...names: string[]): number {
  for (const want of names) {
    const i = row.columns.findIndex((c) => c.toLowerCase() === want.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

function val(row: {values: Array<string | number | null>}, idx: number) {
  return idx < 0 ? null : row.values[idx];
}

// ---------------------------------------------------------------- WorkInfo
// WorkInfo: 书籍元数据（BookNo → BookName / Case / Author ...）
const work = load(DUMP("WorkInfo"));
const bookName = new Map<string, string>();
const bookCase = new Map<string, string>();
if (work.length) {
  const wBookNo = col(work[0]!, "BookNo");
  const wName = col(work[0]!, "BookName");
  const wCase = col(work[0]!, "Case");
  for (const r of work) {
    const no = String(val(r, wBookNo) ?? "");
    bookName.set(no, String(val(r, wName) ?? ""));
    bookCase.set(no, String(val(r, wCase) ?? ""));
  }
}
console.log(`WorkInfo: ${work.length} 行（书目元数据）`);

// ------------------------------------------------------------------- Book
// Book: 篇章（BookInfoId 主键，BookId 外键 → 书）
const book = load(DUMP("Book"));
console.log(`Book: ${book.length} 行（篇章）`);
if (book.length) console.log(`  Book 列: ${book[0]!.columns.slice(0, 8).join(", ")} ...`);

const bInfo = col(book[0]!, "BookInfoId");
const bBookId = col(book[0]!, "BookId");
const bNo = col(book[0]!, "ChapterNo", "ChapterSection", "No");
const bTitle = col(book[0]!, "ChapterHeader", "Chapter", "Title", "Name");

interface Chapter {
  infoId: string;
  bookId: string;
  no: string;
  title: string;
}
const chapters: Chapter[] = [];
for (const r of book) {
  chapters.push({
    infoId: String(val(r, bInfo) ?? ""),
    bookId: String(val(r, bBookId) ?? ""),
    no: String(val(r, bNo) ?? ""),
    title: String(val(r, bTitle) ?? "").trim(),
  });
}
const chapterByInfo = new Map(chapters.map((c) => [c.infoId, c]));

// --------------------------------------------------------------- BookBody
// BookBody: 条文（BookInfoId 外键 → 篇章，ReceiptNo 为条编号/排序键）
const body = load(DUMP("BookBody"));
console.log(`BookBody: ${body.length} 行（条文）`);
if (body.length) console.log(`  BookBody 列: ${body[0]!.columns.slice(0, 8).join(", ")} ...`);

const yInfo = col(body[0]!, "BookInfoId");
const yReceipt = col(body[0]!, "ReceiptNo");

const sectionsByChapter = new Map<string, number[]>();
let orphanSections = 0;
for (const r of body) {
  const infoId = String(val(r, yInfo) ?? "");
  const receipt = Number(val(r, yReceipt) ?? 0);
  if (!chapterByInfo.has(infoId)) orphanSections += 1;
  const list = sectionsByChapter.get(infoId) ?? [];
  list.push(receipt);
  sectionsByChapter.set(infoId, list);
}

// ------------------------------------------------------------ 每本书汇总
console.log("\n================ 每本书：篇章 / 条文 / 编号区间 ================");
const byBook = new Map<string, Chapter[]>();
for (const c of chapters) {
  const list = byBook.get(c.bookId) ?? [];
  list.push(c);
  byBook.set(c.bookId, list);
}

const rows: string[] = [];
for (const [bookId, chs] of [...byBook.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const receipts: number[] = [];
  for (const c of chs) receipts.push(...(sectionsByChapter.get(c.infoId) ?? []));
  const name = bookName.get(bookId) ?? "(无 WorkInfo 记录)";
  const min = receipts.length ? Math.min(...receipts) : 0;
  const max = receipts.length ? Math.max(...receipts) : 0;
  rows.push(
    [
      String(bookId).padEnd(9),
      (name || "?").padEnd(18),
      `Case=${bookCase.get(bookId) ?? "-"}`.padEnd(8),
      `篇章=${String(chs.length).padStart(3)}`,
      `条文=${String(receipts.length).padStart(4)}`,
      receipts.length ? `编号 ${min}..${max}` : "编号 -",
    ].join("  "),
  );
}
console.log(rows.join("\n"));

// ------------------------------------------------------------- 异常检测
console.log("\n================ 异常检测 ================");

// 1) 孤儿条文（BookInfoId 在 Book 表里不存在）
console.log(`1) 孤儿条文（BookInfoId 不在 Book 表）: ${orphanSections} 条`);
if (orphanSections) {
  const bad = new Map<string, number>();
  for (const r of body) {
    const infoId = String(val(r, yInfo) ?? "");
    if (!chapterByInfo.has(infoId)) bad.set(infoId, (bad.get(infoId) ?? 0) + 1);
  }
  console.log(`   涉及的 BookInfoId: ${[...bad.entries()].slice(0, 10).map(([k, v]) => `${k}(${v}条)`).join(", ")}`);
}

// 2) 同一篇章标题出现在多本书里（跨书重名）
const titleToBooks = new Map<string, Set<string>>();
for (const c of chapters) {
  const s = titleToBooks.get(c.title) ?? new Set<string>();
  s.add(c.bookId);
  titleToBooks.set(c.title, s);
}
const dupTitles = [...titleToBooks.entries()].filter(([, s]) => s.size > 1);
console.log(`2) 同名篇章出现在多本书: ${dupTitles.length} 个标题`);
for (const [t, s] of dupTitles.slice(0, 8)) {
  console.log(`   「${t.slice(0, 28)}」→ 书 ${[...s].join(" / ")}`);
}

// 3) 条文编号前缀与所属书编号不一致（编号体系异常）
let prefixMismatch = 0;
const mismatchSample: string[] = [];
for (const c of chapters) {
  const receipts = sectionsByChapter.get(c.infoId) ?? [];
  if (!receipts.length) continue;
  const bookPrefix = String(c.bookId).slice(0, 3);
  const bad = receipts.filter((n) => !String(n).startsWith(bookPrefix));
  if (bad.length) {
    prefixMismatch += bad.length;
    if (mismatchSample.length < 8) {
      mismatchSample.push(
        `   书 ${c.bookId}「${c.title.slice(0, 20)}」有 ${bad.length}/${receipts.length} 条编号不以 ${bookPrefix} 开头，例: ${bad.slice(0, 3).join(",")}`,
      );
    }
  }
}
console.log(`3) 条文编号前缀与书编号不一致: ${prefixMismatch} 条`);
mismatchSample.forEach((s) => console.log(s));

// 4) 空篇章（有篇章无条文）
const emptyChapters = chapters.filter((c) => !(sectionsByChapter.get(c.infoId) ?? []).length);
console.log(`4) 空篇章（无条文）: ${emptyChapters.length} 个`);
for (const c of emptyChapters.slice(0, 6)) {
  console.log(`   书 ${c.bookId} / BookInfoId=${c.infoId}「${c.title.slice(0, 26)}」`);
}

// 5) 编号不连续（同一篇章内 ReceiptNo 有跳号）
let gapChapters = 0;
for (const c of chapters) {
  const rs = [...(sectionsByChapter.get(c.infoId) ?? [])].sort((a, b) => a - b);
  for (let i = 1; i < rs.length; i += 1) {
    if ((rs[i] ?? 0) - (rs[i - 1] ?? 0) !== 1) {
      gapChapters += 1;
      break;
    }
  }
}
console.log(`5) 篇章内条文编号不连续: ${gapChapters} 个篇章`);
