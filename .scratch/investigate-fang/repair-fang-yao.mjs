import {DatabaseSync} from "node:sqlite";
const DB="D:/git/AiCode/microfeed/.microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/miniflare-D1DatabaseObject/e60aa88374e950a08be5ad11bdf5fb22c7e803a0aa157cfb660080323535bcb8.sqlite";
const APPLY=process.argv.includes("--apply");

// 动态解析本地目标药材 id（不硬编码，避免实例差异）
const db=new DatabaseSync(DB,{readOnly:!APPLY});
const yaoRows=db.prepare("SELECT id, json_extract(data,'$.title') AS t FROM items WHERE tcm_kind='yao'").all();
const byBare=new Map();
for(const r of yaoRows){const bare=String(r.t||"").replace(/^\d+、/,"");if(bare){const a=byBare.get(bare)||[];a.push(r.id);byBare.set(bare,a);}}
const resolveLocal=(showName)=>{
  if(byBare.has(showName)&&byBare.get(showName).length===1)return byBare.get(showName)[0];
  // 别名兜底：木防己 -> 防己
  for(const [bare,ids] of byBare){if(ids.length===1&&(bare.includes(showName)||showName.includes(bare)))return ids[0];}
  return null;
};
const ganCao=resolveLocal("甘草");
const fangJi=resolveLocal("防己");
console.log("本地 甘草 id =",ganCao,"| 防己 id =",fangJi);

// 验收映射表：null 行的 showName -> 本地目标药材 id
const TARGET={"甘草":ganCao,"木防己":fangJi};
const unknown=new Set();

const fangs=db.prepare("SELECT id, data FROM items WHERE tcm_kind='fang'").all();
let planned=0, changed=0;
const plans=[];
for(const f of fangs){
  const d=JSON.parse(f.data);
  const list=d._microfeed?.fangYaoList||[];
  let touched=false;
  for(const row of list){
    if(!row.yaoId){
      const tid=TARGET[row.showName];
      if(!tid){unknown.add(row.showName);continue;}
      if(row.yaoId!==tid){row.yaoId=tid;touched=true;planned++;}
    }
  }
  if(touched)plans.push({id:f.id,data:d});
}
console.log("待修复 fang 条目数:",plans.length,"| 待填 yaoId 行数:",planned);
if(unknown.size)console.log("⚠️ 未识别 showName (跳过):",[...unknown]);

if(APPLY){
  const stmt=db.prepare("UPDATE items SET data=?, updated_at=? WHERE id=?");
  for(const p of plans){stmt.run(JSON.stringify(p.data),new Date().toISOString(),p.id);changed++;}
  console.log("已更新 fang 条目:",changed);
}
db.close();
console.log(APPLY?"==== APPLY 完成 ====":"==== DRY-RUN（加 --apply 真正写入）====");
