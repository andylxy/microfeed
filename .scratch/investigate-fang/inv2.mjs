import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";

// ---- minimal MySQL dump row parser (reuse from fix-fang-yao) ----
const splitTop = (s) => {
  const out = []; let cur = ""; let d = 0; let ins = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ins) { if (ch === "'") { if (s[i+1] === "'") { cur += "''"; i++; } else ins = false; } cur += ch; }
    else if (ch === "'") { ins = true; cur += ch; }
    else if (ch === "(") { d++; cur += ch; }
    else if (ch === ")") { d--; cur += ch; }
    else if (ch === "," && d === 0) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
};
const clean = (v) => { v = v.trim(); if (v === "NULL") return null; if (v.startsWith("'")) return v.slice(1,-1).replace(/''/g,"'"); return v; };
const parseRows = (path, cols) => {
  const text = readFileSync(path, "utf8"); const out = [];
  for (const m of text.matchAll(/VALUES\s*\((.*?)\)\s*;/gs)) {
    const vals = splitTop(m[1]);
    if (vals.length >= cols.length) { const row = {}; cols.forEach((c,i)=>row[c]=clean(vals[i])); out.push(row); }
  }
  return out;
};
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const idOwner = new Map();
const tcmId = (kind, sourceKey) => {
  const owner = kind + ":" + sourceKey;
  for (let salt = 0; salt < 8; salt++) {
    const digest = createHash("sha256").update(owner + "#" + salt).digest();
    let id = ""; for (const byte of digest) { id += BASE62[byte % 62]; if (id.length === 11) break; }
    const claimed = idOwner.get(id);
    if (claimed === undefined) { idOwner.set(id, owner); return id; }
    if (claimed === owner) return id;
  }
  throw new Error("collision " + owner);
};

const yao = parseRows("D:/git/AiCode/microfeed/ctwh/Yao.sql", ["YaoId","YaoNo","YaoName","YaoBieMing","YaoText","YaoList"]);
for (const r of yao) tcmId("yao", String(r.YaoId)); // pre-warm same as import
const yaoSourceIdSet = new Set(yao.map(r=>String(r.YaoId)));
const byYaoId = new Map(yao.map(r=>[String(r.YaoId), r.YaoName]));

const fang = parseRows("D:/git/AiCode/microfeed/ctwh/Fang.sql", ["FangId","FangName","FangSourceBookId","FangNo","YaoCount","FangdrinkNum","YaoList","FangList","FangText","CreateDate"]);
const guizhen = fang.find(r => r.FangName.trim() === "桂枝汤");
console.log("=== 桂枝汤 source row ===");
console.log(JSON.stringify(guizhen, null, 2));

const fb = parseRows("D:/git/AiCode/microfeed/ctwh/FangBody.sql", ["FangBodyId","FangId","Amount","YaoID","Weight","Suffix","ShowName","ExtraProcess"]);
const rows = fb.filter(r => r.FangId === guizhen.FangId).sort((a,b)=>Number(a.FangBodyId)-Number(b.FangBodyId));
console.log("\n=== 桂枝汤 FangBody 组成 (FangId="+guizhen.FangId+") ===");
for (const r of rows) {
  const yaoSourceKey = Number(r.YaoID) + 1;
  const inSet = yaoSourceIdSet.has(String(yaoSourceKey));
  const resolvedName = byYaoId.get(String(yaoSourceKey));
  const computedId = inSet ? tcmId("yao", String(yaoSourceKey)) : null;
  console.log(`ShowName=${r.ShowName} 源YaoID=${r.YaoID} -> +1=${yaoSourceKey} 在集合=${inSet} 应解析药材=${resolvedName} computedId=${computedId}`);
}
console.log("\n本地 甘草 item id =", tcmId("yao","1"), "（应与上表 甘草 的 computedId 一致）");
