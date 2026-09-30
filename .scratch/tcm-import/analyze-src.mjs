// 实证：抽出 ctwh 源三表（WorkInfo/Book/BookBody）的真实关联键，判断导入脚本的 join 是否错位。
import { readFileSync } from "node:fs";

function tokenizeValues(body) {
  // body = 介于 "VALUES (" 与 行尾 ";" 之间的内容；返回前 N 个字段（含引号解析）
  const out = [];
  let i = 0;
  let inStr = false;
  let tok = "";
  let saw = false;
  let quoted = false;
  const push = () => {
    if (!saw) out.push(null);
    else out.push(quoted ? tok : (tok.match(/^-?\d+$/) ? Number(tok) : tok));
    tok = ""; saw = false; quoted = false;
  };
  while (i < body.length) {
    const c = body[i];
    if (inStr) {
      if (c === "\\") { tok += c + (body[i + 1] ?? ""); i += 2; continue; }
      if (c === "'") {
        if (body[i + 1] === "'") { tok += "''"; i += 2; continue; }
        inStr = false; tok = tok.replace(/''/g, "'"); i += 1; continue;
      }
      tok += c; i += 1; continue;
    }
    if (c === "'") { inStr = true; saw = true; quoted = true; i += 1; continue; }
    if (c === ",") { push(); i += 1; continue; }
    if (c === ")") { push(); break; }
    if (c === "NULL") { i += 4; continue; }
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { i += 1; continue; }
    saw = true; tok += c; i += 1;
  }
  return out;
}

function rowsOf(file, cols) {
  const text = readFileSync(file, "utf8");
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("INSERT INTO")) continue;
    const m = /^INSERT INTO `([^`]+)` \(([^)]*)\) VALUES \(/.exec(line);
    if (!m) continue;
    const names = m[2].split(",").map((s) => s.trim().replace(/^`|`$/g, ""));
    const body = line.slice(m[0].length).replace(/;\s*$/, "");
    const vals = tokenizeValues(body);
    const obj = {};
    names.forEach((n, idx) => (obj[n] = vals[idx] ?? null));
    out.push(obj);
  }
  return out;
}

const work = rowsOf("ctwh/WorkInfo.sql");
const book = rowsOf("ctwh/Book.sql");
const body = rowsOf("ctwh/BookBody.sql");

console.log("=== WorkInfo: ChapterId -> BookNo -> BookName (全部) ===");
const wi = new Map();
for (const r of work) wi.set(r.ChapterId, { BookNo: r.BookNo, BookName: r.BookName, Case: r.Case });
for (const [cid, v] of wi) console.log(`  ChapterId=${cid}  BookNo=${v.BookNo}  Case=${v.Case}  《${v.BookName}》`);

console.log(`\n=== Book: 按 BookId 分组（去重 BookInfoId / 计数 / 样例 ChapterHeader） ===`);
const byBookId = new Map();
for (const r of book) {
  const key = r.BookId;
  const g = byBookId.get(key) ?? { BookName: r.BookName, bookInfoIds: new Set(), count: 0, headers: [] };
  g.BookName = r.BookName;
  g.bookInfoIds.add(r.BookInfoId);
  g.count += 1;
  if (g.headers.length < 4) g.headers.push(`${r.ChapterSection}:${r.ChapterHeader}`);
  byBookId.set(key, g);
}
for (const [bid, g] of [...byBookId.entries()].sort()) {
  console.log(`  BookId=${bid}  《${g.BookName}》  篇章数=${g.count}  BookInfoId集合=[${[...g.bookInfoIds].join(",")}]`);
  for (const h of g.headers) console.log(`      ${h}`);
}

console.log(`\n=== BookBody: 按 BookInfoId 分组（计数） ===`);
const bodyByInfo = new Map();
for (const r of body) {
  const g = bodyByInfo.get(r.BookInfoId) ?? { count: 0, receiptMin: null, receiptMax: null };
  g.count += 1;
  const rn = Number(r.ReceiptNo ?? 0);
  if (g.receiptMin == null || rn < g.receiptMin) g.receiptMin = rn;
  if (g.receiptMax == null || rn > g.receiptMax) g.receiptMax = rn;
  bodyByInfo.set(r.BookInfoId, g);
}
for (const [bi, g] of [...bodyByInfo.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
  console.log(`  BookBody.BookInfoId=${bi}  条文数=${g.count}  ReceiptNo范围=[${g.receiptMin}..${g.receiptMax}]`);
}

console.log(`\n=== 交叉核对：Book 表的 BookInfoId 集合 vs BookBody 表的 BookInfoId 集合 ===`);
const bookInfoIds = new Set();
for (const r of book) bookInfoIds.add(r.BookInfoId);
const bodyInfoIds = new Set();
for (const r of body) bodyInfoIds.add(r.BookInfoId);
const onlyBook = [...bookInfoIds].filter((x) => !bodyInfoIds.has(x));
const onlyBody = [...bodyInfoIds].filter((x) => !bookInfoIds.has(x));
console.log(`  Book 独有 BookInfoId = [${onlyBook.join(",")}]`);
console.log(`  BookBody 独有 BookInfoId = [${onlyBody.join(",")}]`);
console.log(`  重叠 BookInfoId = [${[...bookInfoIds].filter((x) => bodyInfoIds.has(x)).join(",")}]`);

console.log(`\n=== 总计数 ===`);
console.log(`  WorkInfo 行数 = ${work.length}`);
console.log(`  Book 行数（篇章目录） = ${book.length}`);
console.log(`  BookBody 行数（条文正文） = ${body.length}`);
