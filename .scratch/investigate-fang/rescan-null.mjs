import {DatabaseSync} from "node:sqlite";
const DB = "D:/git/AiCode/microfeed/.microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/miniflare-D1DatabaseObject/e60aa88374e950a08be5ad11bdf5fb22c7e803a0aa157cfb660080323535bcb8.sqlite";
const db = new DatabaseSync(DB, {readOnly: true});
const rows = db.prepare("SELECT id, data FROM items WHERE tcm_kind='fang'").all();
let nullRows = 0, totalFang = rows.length, totalRows = 0;
const byName = {};
for (const r of rows) {
  const d = JSON.parse(r.data);
  const list = d._microfeed && Array.isArray(d._microfeed.fangYaoList) ? d._microfeed.fangYaoList : [];
  totalRows += list.length;
  for (const y of list) {
    if (y.yaoId == null) {
      nullRows++;
      const key = y.showName || "(空showName)";
      byName[key] = (byName[key] || 0) + 1;
    }
  }
}
console.log("方剂条目数:", totalFang);
console.log("组成行总数:", totalRows);
console.log("yaoId=null 行数:", nullRows);
console.log("按 showName 分组:", JSON.stringify(byName));
// 桂枝汤样本
const gz = db.prepare("SELECT id, data FROM items WHERE tcm_kind='fang' AND json_extract(data,'$.title') LIKE '%桂枝汤%' LIMIT 3").all();
for (const r of gz) {
  const d = JSON.parse(r.data);
  const list = d._microfeed.fangYaoList || [];
  console.log("桂枝汤样例 id=", r.id, " 组成数=", list.length, " 含null=", list.filter(x=>x.yaoId==null).length);
}
