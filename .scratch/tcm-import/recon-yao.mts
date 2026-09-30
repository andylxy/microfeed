import {readFileSync} from "node:fs";
import {iterInsertRows} from "../../scripts/import-ctwh/parse.ts";
function rowsOf(f: string){ return [...iterInsertRows(readFileSync("ctwh/"+f,"utf8"))]; }
function rv(r: any, c: string){ const i=r.columns.indexOf(c); return i===-1?null:(r.values[i]??null); }
const fang = rowsOf("Fang.sql").filter(r=>String(rv(r,"FangSourceBookId")??"")==="1001000");
const fangIds = new Set(fang.map(r=>String(rv(r,"FangId")??"")));
const fangBody = rowsOf("FangBody.sql").filter(r=>fangIds.has(String(rv(r,"FangId")??"")));
const yaoIds = new Set(fangBody.map(r=>String(rv(r,"YaoID")??"")).filter(Boolean));
console.log("本书方剂数:", fang.length, "组成行:", fangBody.length, "引用 distinct YaoID:", yaoIds.size);
const yao = rowsOf("Yao.sql").filter(r=>yaoIds.has(String(rv(r,"YaoId")??"")));
console.log("命中的 Yao 条目:", yao.length);
const alias = rowsOf("yaoAlias.sql").filter(r=>yao.has ? yaoIds.has(String(rv(r,"YaoId")??"")) : false);
console.log("这些 yao 的 alias 行数:", alias.length);
