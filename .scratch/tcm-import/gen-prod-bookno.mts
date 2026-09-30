import {readFileSync, writeFileSync} from "node:fs";
import {iterInsertRows} from "../../scripts/import-ctwh/parse.ts";
import {tcmId} from "../../scripts/import-ctwh/build.ts";
function rowsOf(f: string){ return [...iterInsertRows(readFileSync("ctwh/"+f,"utf8"))]; }
function rv(r: any, c: string){ const i=r.columns.indexOf(c); return i===-1?null:(r.values[i]??null); }
const stmts = rowsOf("WorkInfo.sql").map(r => {
  const chapterId = String(rv(r,"ChapterId")??"");
  const bookNo = String(rv(r,"BookNo")??"");
  const id = tcmId("work", chapterId);
  return `UPDATE channels SET data=json_set(data,'$._microfeed.bookNo','${bookNo}') WHERE id='${id}' AND json_extract(data,'$._microfeed.bookNo') IS NULL;`;
});
writeFileSync(".scratch/tcm-import/out-prod-fix/prod-bookno.sql", stmts.join("\n")+"\n");
console.log("UPDATE 条数:", stmts.length);
