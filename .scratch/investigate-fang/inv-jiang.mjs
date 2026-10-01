import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
const splitTop=(s)=>{const out=[];let cur="";let dd=0;let ins=false;for(let i=0;i<s.length;i++){const ch=s[i];if(ins){if(ch==="'"){if(s[i+1]==="'"){cur+="''";i++;}else ins=false;}cur+=ch;}else if(ch==="'"){ins=true;cur+=ch;}else if(ch==="("){dd++;cur+=ch;}else if(ch===")"){dd--;cur+=ch;}else if(ch===","&&dd===0){out.push(cur);cur="";}else cur+=ch;}if(cur.trim())out.push(cur);return out;};
const clean=(v)=>{v=v.trim();if(v==="NULL")return null;if(v.startsWith("'"))return v.slice(1,-1).replace(/''/g,"'");return v;};
const parseRows=(p,cols)=>{const t=readFileSync(p,"utf8");const o=[];for(const m of t.matchAll(/VALUES\s*\((.*?)\)\s*;/gs)){const v=splitTop(m[1]);if(v.length>=cols.length){const r={};cols.forEach((c,i)=>r[c]=clean(v[i]));o.push(r);}}return o;};

const yao=parseRows("D:/git/AiCode/microfeed/ctwh/Yao.sql",["YaoId","YaoNo","YaoName","YaoBieMing","YaoText","YaoList"]);
const byYaoId=new Map(yao.map(r=>[String(r.YaoId),r.YaoName]));
const fb=parseRows("D:/git/AiCode/microfeed/ctwh/FangBody.sql",["FangBodyId","FangId","Amount","YaoID","Weight","Suffix","ShowName","ExtraProcess"]);
const fang=parseRows("D:/git/AiCode/microfeed/ctwh/Fang.sql",["FangId","FangName"]);

// 源里 ShowName=姜 的行
const jiangRows=fb.filter(r=>r.ShowName==="姜");
console.log("=== 源 FangBody ShowName=姜 ===",jiangRows.length,"行");
for(const r of jiangRows.slice(0,10)){
  const k=Number(r.YaoID)+1;
  console.log(`FangId=${r.FangId} 方剂=${fang.find(f=>f.FangId===r.FangId)?.FangName} 源YaoID=${r.YaoID} -> +1=${k} 应解析=${byYaoId.get(String(k))}`);
}
// 本地 yao 含姜/附子的
const db=new DatabaseSync("D:/git/AiCode/microfeed/.microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/miniflare-D1DatabaseObject/e60aa88374e950a08be5ad11bdf5fb22c7e803a0aa157cfb660080323535bcb8.sqlite");
const yaoLocal=db.prepare("SELECT id, json_extract(data,'$.title') AS t FROM items WHERE tcm_kind='yao' AND json_extract(data,'$.title') LIKE '%姜%'").all();
console.log("\n本地 含「姜」的 yao 条目:",JSON.stringify(yaoLocal,null,2));
const fu=db.prepare("SELECT id, json_extract(data,'$.title') AS t FROM items WHERE tcm_kind='yao' AND json_extract(data,'$.title') LIKE '%附子%'").all();
console.log("本地 含「附子」的 yao 条目:",JSON.stringify(fu,null,2));
// 本地所有 showName=姜 的 fangYaoList 行
const fangs=db.prepare("SELECT id, data FROM items WHERE tcm_kind='fang'").all();
let cnt=0;
console.log("\n本地 fangYaoList showName=姜 的行:");
for(const f of fangs){const d=JSON.parse(f.data);for(const row of (d._microfeed?.fangYaoList||[])){if(row.showName==="姜"){const rt=row.yaoId?db.prepare("SELECT json_extract(data,'$.title') AS t FROM items WHERE id=?").get(row.yaoId)?.t:null;cnt++;if(cnt<=8)console.log(`  fang=${d.title} yaoId=${row.yaoId} 解析=${rt}`);}}}
console.log("本地 showName=姜 总行数:",cnt);
db.close();
