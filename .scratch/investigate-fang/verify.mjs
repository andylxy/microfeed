import {DatabaseSync} from "node:sqlite";
const db=new DatabaseSync("D:/git/AiCode/microfeed/.microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/miniflare-D1DatabaseObject/e60aa88374e950a08be5ad11bdf5fb22c7e803a0aa157cfb660080323535bcb8.sqlite");
const yaoTitle=new Map();
for(const r of db.prepare("SELECT id, json_extract(data,'$.title') AS t FROM items WHERE tcm_kind='yao'").all())yaoTitle.set(r.id,r.t);

// 1) 桂枝汤 核验
const item=db.prepare("SELECT data FROM items WHERE id='UN8KV9xhXQH'").get();
const d=JSON.parse(item.data);
console.log("=== 桂枝汤(UN8KV9xhXQH) 药味组成 ===");
let ok=0,bad=0;
for(const row of d._microfeed.fangYaoList){
  const resolved=row.yaoId?yaoTitle.get(row.yaoId):"(null)";
  const isOk=row.yaoId&&resolved&&resolved.replace(/^\d+、/,"")===row.showName;
  if(isOk)ok++;else bad++;
  console.log(`  ${row.showName}  yaoId=${row.yaoId} -> ${resolved}  ${isOk?"OK":"<<BAD>>"}`);
}
console.log(`  结果: ${ok} 正确 / ${bad} 异常`);

// 2) 系统性复扫
const fangs=db.prepare("SELECT id, data FROM items WHERE tcm_kind='fang'").all();
let nullRows=0, mismatch=0, total=0;
for(const f of fangs){const fd=JSON.parse(f.data);for(const row of (fd._microfeed?.fangYaoList||[])){total++;if(!row.yaoId)nullRows++;else{const r=yaoTitle.get(row.yaoId);if(!r||r.replace(/^\d+、/,"")!==row.showName)mismatch++;}}}
console.log("\n=== 全量复扫 ===");
console.log(`fangYaoList 总行数: ${total}`);
console.log(`仍为空 yaoId 行数: ${nullRows}  ${nullRows===0?"✅ 全部修复":"❌ 仍有缺失"}`);
console.log(`名称不匹配(别名展示, 非错误)行数: ${mismatch}`);
db.close();
