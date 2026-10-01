import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
const splitTop = (s) => { const out=[];let cur="";let d=0;let ins=false;for(let i=0;i<s.length;i++){const ch=s[i];if(ins){if(ch==="'"){if(s[i+1]==="'"){cur+="''";i++;}else ins=false;}cur+=ch;}else if(ch==="'"){ins=true;cur+=ch;}else if(ch==="("){d++;cur+=ch;}else if(ch===")"){d--;cur+=ch;}else if(ch===","&&d===0){out.push(cur);cur="";}else cur+=ch;}if(cur.trim())out.push(cur);return out; };
const clean=(v)=>{v=v.trim();if(v==="NULL")return null;if(v.startsWith("'"))return v.slice(1,-1).replace(/''/g,"'");return v;};
const parseRows=(path,cols)=>{const text=readFileSync(path,"utf8");const out=[];for(const m of text.matchAll(/VALUES\s*\((.*?)\)\s*;/gs)){const vals=splitTop(m[1]);if(vals.length>=cols.length){const row={};cols.forEach((c,i)=>row[c]=clean(vals[i]));out.push(row);}}return out;};

const yao = parseRows("D:/git/AiCode/microfeed/ctwh/Yao.sql",["YaoId","YaoNo","YaoName","YaoBieMing","YaoText","YaoList"]);
const yaoSourceIdSet=new Set(yao.map(r=>String(r.YaoId)));
const byYaoId=new Map(yao.map(r=>[String(r.YaoId),r.YaoName]));
const fang=parseRows("D:/git/AiCode/microfeed/ctwh/Fang.sql",["FangId","FangName","FangSourceBookId","FangNo","YaoCount","FangdrinkNum","YaoList","FangList","FangText","CreateDate"]);
const fb=parseRows("D:/git/AiCode/microfeed/ctwh/FangBody.sql",["FangBodyId","FangId","Amount","YaoID","Weight","Suffix","ShowName","ExtraProcess"]);

// (1) FangName uniqueness
const nameCount=new Map();
for(const r of fang){const n=r.FangName.trim();nameCount.set(n,(nameCount.get(n)||0)+1);}
const dups=[...nameCount.entries()].filter(([,c])=>c>1);
console.log("Fang.sql 方剂数:",fang.length,"| 重名 FangName 数:",dups.length, dups.slice(0,5));

// (2) 木防己 in source
console.log("\n=== 木防己 source ===");
const muRows=fb.filter(r=>r.ShowName&&r.ShowName.includes("木防己"));
for(const r of muRows){const k=Number(r.YaoID)+1;console.log(`FangId=${r.FangId} ShowName=${r.ShowName} YaoID=${r.YaoID} -> +1=${k} 在集合=${yaoSourceIdSet.has(String(k))} 药材=${byYaoId.get(String(k))}`);}
const fangWithMu=[...new Set(muRows.map(r=>r.FangId))];
console.log("含 木防己 的 FangId:",fangWithMu,"对应方剂名:",fangWithMu.map(id=>fang.find(f=>f.FangId===id)?.FangName));

// (3) local yao 木防己 / 防己
const db=new DatabaseSync("D:/git/AiCode/microfeed/.microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/miniflare-D1DatabaseObject/e60aa88374e950a08be5ad11bdf5fb22c7e803a0aa157cfb660080323535bcb8.sqlite");
const yaoLocal=db.prepare("SELECT id, json_extract(data,'$.title') AS t FROM items WHERE tcm_kind='yao' AND (json_extract(data,'$.title') LIKE '%防己%' OR json_extract(data,'$.title') LIKE '%木防己%')").all();
console.log("\n本地 防己/木防己 yao:",JSON.stringify(yaoLocal,null,2));
db.close();

// (4) how many fangs actually have FangBody in source
const fangIdsWithBody=new Set(fb.map(r=>r.FangId));
console.log("\n源 FangBody 覆盖的 FangId 数:",fangIdsWithBody.size,"| FangBody 总行数:",fb.length);
