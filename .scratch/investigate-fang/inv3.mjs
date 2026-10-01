import {DatabaseSync} from "node:sqlite";
const db = new DatabaseSync("D:/git/AiCode/microfeed/.microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/miniflare-D1DatabaseObject/e60aa88374e950a08be5ad11bdf5fb22c7e803a0aa157cfb660080323535bcb8.sqlite");

// index local yao items by id
const yaoRows = db.prepare("SELECT id, data FROM items WHERE tcm_kind='yao'").all();
const yaoTitle = new Map();
const yaoByBare = new Map();
for (const r of yaoRows) {
  const d = JSON.parse(r.data);
  const t = String(d.title||"");
  yaoTitle.set(r.id, t);
  const bare = t.replace(/^\d+、/, "");
  if (bare) { const arr = yaoByBare.get(bare)||[]; arr.push(r.id); yaoByBare.set(bare, arr); }
}
console.log("本地 yao 总数:", yaoRows.length, "| 同名裸名重复数:", [...yaoByBare.values()].filter(a=>a.length>1).length);
for (const [b,ids] of yaoByBare) if (ids.length>1) console.log("  重复裸名:", b, ids);

// resolve 桂枝汤
const item = db.prepare("SELECT id, data FROM items WHERE id='UN8KV9xhXQH'").get();
const d = JSON.parse(item.data);
console.log("\n=== 桂枝汤 本地 fangYaoList ===");
let ok=0, bad=0;
for (const row of d._microfeed.fangYaoList) {
  const resolved = row.yaoId ? yaoTitle.get(row.yaoId) : "(null)";
  const isOk = row.yaoId && resolved && (resolved.replace(/^\d+、/,"") === row.showName);
  if (isOk) ok++; else bad++;
  console.log(`showName=${row.showName}  yaoId=${row.yaoId}  -> 解析药材=${resolved}  ${isOk?"OK":"<<MISMATCH/MISSING>>"}`);
}
console.log(`本地 桂枝汤: 匹配 ${ok} / 不匹配或缺失 ${bad}`);

// systemic scan: all fang items, count null yaoId rows & mismatches
console.log("\n=== 系统性扫描: 所有本地 fang 条目 ===");
const fangs = db.prepare("SELECT id, data FROM items WHERE tcm_kind='fang'").all();
let totalFangs=0, fangWithNull=0, totalNullRows=0, totalRows=0, totalMismatch=0;
const nullByShowName = {};
for (const f of fangs) {
  totalFangs++;
  const fd = JSON.parse(f.data);
  const list = fd._microfeed?.fangYaoList || [];
  for (const row of list) {
    totalRows++;
    if (!row.yaoId) { totalNullRows++; fangWithNull++; nullByShowName[row.showName]=(nullByShowName[row.showName]||0)+1; }
    else {
      const resolved = yaoTitle.get(row.yaoId);
      if (!resolved || resolved.replace(/^\d+、/,"") !== row.showName) totalMismatch++;
    }
  }
}
console.log("fang 总数:", totalFangs, "| 含 null 行的 fang 数:", fangWithNull);
console.log("fangYaoList 总行数:", totalRows, "| null 行数:", totalNullRows, "| 名称不匹配行数:", totalMismatch);
console.log("null 行的 showName 分布:", JSON.stringify(nullByShowName, null, 2));
db.close();
