import {DatabaseSync} from "node:sqlite";
const db=new DatabaseSync("D:/git/AiCode/microfeed/.microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/miniflare-D1DatabaseObject/e60aa88374e950a08be5ad11bdf5fb22c7e803a0aa157cfb660080323535bcb8.sqlite");

// 1) fang -> book 关系
const fangs=db.prepare("SELECT id, book_id, data FROM items WHERE tcm_kind='fang'").all();
const channels=new Set(db.prepare("SELECT id FROM channels").all().map(r=>r.id));
let nullSrc=0, badBook=0, nonContainer=0;
const srcSet=new Set();
for(const f of fangs){
  const d=JSON.parse(f.data);
  const src=d._microfeed?.sourceBookId;
  if(!src)nullSrc++; else { srcSet.add(src); if(!channels.has(src))badBook++; }
  if(f.book_id!=="tcmfang0001")nonContainer++;
}
console.log("fang 总数:",fangs.length);
console.log("sourceBookId 为空:",nullSrc,"| sourceBookId 指向不存在频道:",badBook);
console.log("book_id != 容器(tcmfang0001):",nonContainer);
console.log("涉及的不同 sourceBookId 数:",srcSet.size);

// 2) 96 个 showName!=resolved 是否都是合法别名/异写（不是真错链）
const yaoRows=db.prepare("SELECT id, data FROM items WHERE tcm_kind='yao'").all();
const yaoTitle=new Map(); const yaoByBare=new Map();
for(const r of yaoRows){const t=String(JSON.parse(r.data).title||"");yaoTitle.set(r.id,t);const b=t.replace(/^\d+、/,"");if(b){const a=yaoByBare.get(b)||[];a.push(t);yaoByBare.set(b,a);}}
// 源 Yao 别名表
import {readFileSync} from "node:fs";
const splitTop=(s)=>{const out=[];let cur="";let dd=0;let ins=false;for(let i=0;i<s.length;i++){const ch=s[i];if(ins){if(ch==="'"){if(s[i+1]==="'"){cur+="''";i++;}else ins=false;}cur+=ch;}else if(ch==="'"){ins=true;cur+=ch;}else if(ch==="("){dd++;cur+=ch;}else if(ch===")"){dd--;cur+=ch;}else if(ch===","&&dd===0){out.push(cur);cur="";}else cur+=ch;}if(cur.trim())out.push(cur);return out;};
const clean=(v)=>{v=v.trim();if(v==="NULL")return null;if(v.startsWith("'"))return v.slice(1,-1).replace(/''/g,"'");return v;};
const aliasText=readFileSync("D:/git/AiCode/microfeed/ctwh/yaoAlias.sql","utf8");
const aliasSet=new Set();
for(const m of aliasText.matchAll(/VALUES\s*\((.*?)\)\s*;/gs)){const v=splitTop(m[1]);if(v.length>=2){const name=clean(v[1]);if(name)aliasSet.add(name);}}
let legitAlias=0, genuine=0; const genuineList=[];
let total=0;
for(const f of fangs){const d=JSON.parse(f.data);for(const row of (d._microfeed?.fangYaoList||[])){if(row.yaoId){const r=yaoTitle.get(row.yaoId);if(r){const bare=r.replace(/^\d+、/,"");total++;if(bare!==row.showName){if(aliasSet.has(row.showName)||bare.includes(row.showName)||row.showName.includes(bare)||yaoByBare.has(row.showName))legitAlias++;else{genuine++;if(genuineList.length<10)genuineList.push({show:row.showName,resolved:bare});}}}}}}
console.log("\n药味名称!=解析药材 总数:",total>0?undefined:0,"(重算)");
console.log("合法别名/异写(非错误):",legitAlias,"| 疑似真错链:",genuine, JSON.stringify(genuineList));
db.close();
