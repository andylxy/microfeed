import {readFileSync, writeFileSync, mkdirSync} from "node:fs";
import {iterInsertRows} from "../../scripts/import-ctwh/parse.ts";
import {tcmId} from "../../scripts/import-ctwh/build.ts";
function rowsOf(f: string){ return [...iterInsertRows(readFileSync("ctwh/"+f,"utf8"))]; }
function rv(r: any, c: string){ const i=r.columns.indexOf(c); return i===-1?null:(r.values[i]??null); }
const fang = rowsOf("Fang.sql").filter(r=>String(rv(r,"FangSourceBookId")??"")==="1001000");
const ordered = [...fang].sort((a,b)=>{
  const av = BigInt(String(rv(a,"FangId")??"0")); const bv = BigInt(String(rv(b,"FangId")??"0"));
  return av<bv?-1:av>bv?1:0;
});
const stmts = ordered.map((row, i) => {
  const id = tcmId("fang", String(rv(row,"FangId")??""));
  return `UPDATE items SET data=json_set(data,'$._microfeed.no',${i+1}) WHERE id='${id}';`;
});
mkdirSync(".scratch/tcm-import/out-prod-fix",{recursive:true});
writeFileSync(".scratch/tcm-import/out-prod-fix/prod-fang-no-1001000.sql", stmts.join("\n")+"\n");
console.log("UPDATE 条数:", stmts.length);
