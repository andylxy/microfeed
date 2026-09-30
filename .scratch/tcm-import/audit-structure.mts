// 结构核对：ctwh 源 vs 本地库 —— 每部书的 卷(Book)/章节(chapter item)/正文(section item) 数量与内容抽样
import {DatabaseSync} from "node:sqlite";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {iterInsertRows, rowValue} from "../../scripts/import-ctwh/parse";

const sourceDir = join(import.meta.dirname, "../../ctwh");
const LOCAL = ".microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/miniflare-D1DatabaseObject/e60aa88374e950a08be5ad11bdf5fb22c7e803a0aa157cfb660080323535bcb8.sqlite";

const rowsOf = (file: string) => [...iterInsertRows(readFileSync(join(sourceDir, file), "utf8"))];
const work = rowsOf("WorkInfo.sql");
const book = rowsOf("Book.sql");
const bookBody = rowsOf("BookBody.sql");
const fangRows = rowsOf("Fang.sql");
const yaoRows = rowsOf("Yao.sql");
const mingciRows = rowsOf("MingCi.sql");

// 源侧统计
const chaptersByBookId = new Map<string, number>();
for (const r of book) {
  const bid = String(rowValue(r, "BookId") ?? "");
  chaptersByBookId.set(bid, (chaptersByBookId.get(bid) ?? 0) + 1);
}
const sectionsByBookInfoId = new Map<string, number>();
for (const r of bookBody) {
  const biid = String(rowValue(r, "BookInfoId") ?? "");
  sectionsByBookInfoId.set(biid, (sectionsByBookInfoId.get(biid) ?? 0) + 1);
}

const db = new DatabaseSync(LOCAL, {readOnly: true});
const chans = db.prepare("SELECT id, json_extract(data,'$.title') title, json_extract(data,'$._microfeed.bookNo') bookNo, json_extract(data,'$._microfeed.case') cse FROM channels WHERE genre IS NOT NULL AND genre!='' ORDER BY title").all();
console.log("=== 逐书核对（卷=chapter 条目 / 正文=section 条目）===");
let allOk = true;
for (const c of chans) {
  const bookNo = String(c.bookNo ?? "");
  if (!bookNo) { console.log(`  ${c.title}: 无 bookNo（容器/主频道，跳过）`); continue; }
  const srcChapters = chaptersByBookId.get(bookNo) ?? 0;
  const localChapters = db.prepare("SELECT COUNT(*) c FROM items WHERE book_id=? AND tcm_kind='chapter'").get(c.id).c;
  const localSections = db.prepare("SELECT COUNT(*) c FROM items WHERE book_id=? AND tcm_kind='section'").get(c.id).c;
  // 源章节对应条文数 = 该书所有 Book 行的 BookInfoId 之 BookBody 计数和
  let srcSections = 0;
  for (const r of book) if (String(rowValue(r, "BookId") ?? "") === bookNo) srcSections += sectionsByBookInfoId.get(String(rowValue(r, "BookInfoId") ?? "")) ?? 0;
  const ok = srcChapters === localChapters && srcSections === localSections;
  if (!ok) allOk = false;
  console.log(`  ${ok ? "✅" : "❌"} ${c.title} (bookNo=${bookNo} case=${c.cse}): 卷 源${srcChapters} vs 库${localChapters} | 正文 源${srcSections} vs 库${localSections}`);
}
console.log("=== 方剂/中药/名词 ===");
const fang = db.prepare("SELECT COUNT(*) c FROM items WHERE tcm_kind='fang'").get().c;
const yao = db.prepare("SELECT COUNT(*) c FROM items WHERE tcm_kind='yao'").get().c;
const term = db.prepare("SELECT COUNT(*) c FROM items WHERE tcm_kind='term'").get().c;
console.log(`  方剂 源${fangRows.length} vs 库${fang} | 中药 源${yaoRows.length} vs 库${yao} | 名词 源${mingciRows.length} vs 库${term}`);
console.log(allOk ? "结构核对：全部 ✅" : "结构核对：存在 ❌，见上");
db.close();
