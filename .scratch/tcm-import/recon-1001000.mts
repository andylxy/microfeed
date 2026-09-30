import {readFileSync} from "node:fs";
import {iterInsertRows} from "../../scripts/import-ctwh/parse.ts";
function rowsOf(f: string){ return [...iterInsertRows(readFileSync("ctwh/"+f,"utf8"))]; }
function rv(r: any, c: string){ const i=r.columns.indexOf(c); return i===-1?null:(r.values[i]??null); }
const work = rowsOf("WorkInfo.sql").filter(r=>String(rv(r,"BookNo"))==="1001000");
console.log("WorkInfo 1001000 行数:", work.length);
work.forEach(w=>console.log("  ChapterId="+rv(w,"ChapterId")+" Case="+rv(w,"Case")+" BookName="+rv(w,"BookName")+" Author="+rv(w,"Author")+" Chapter="+rv(w,"Chapter")));
const bookRows = rowsOf("Book.sql").filter(r=>String(rv(r,"BookId"))==="1001000");
console.log("Book(篇章) 1001000 行数:", bookRows.length);
const bodyIds = new Set(bookRows.map(r=>String(rv(r,"BookInfoId")??"")));
const body = rowsOf("BookBody.sql").filter(r=>bodyIds.has(String(rv(r,"BookInfoId")??"")));
console.log("BookBody(条文) 挂本章行数:", body.length);
const fang = rowsOf("Fang.sql").filter(r=>String(rv(r,"FangSourceBookId")??"")==="1001000");
console.log("Fang(方剂) 来源本排行数:", fang.length);
console.log("Yao 总行数:", rowsOf("Yao.sql").length, "(全局目录)");
console.log("MingCi 总行数:", rowsOf("MingCi.sql").length, "(全局目录)");
