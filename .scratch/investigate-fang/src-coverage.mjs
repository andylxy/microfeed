import {readFileSync} from "node:fs";
// 看源 FangBody.sql 列序 + distinct FangId 数
const sql = readFileSync("ctwh/FangBody.sql", "utf8");
const lines = sql.split(/\r?\n/).filter(l => l.trim().startsWith("INSERT INTO"));
console.log("INSERT INTO 行数:", lines.length);
if (lines[0]) {
  // 取 CREATE 表的列定义
  const createMatch = sql.match(/CREATE TABLE[^\n]*?\(([\s\S]*?)\)/);
  if (createMatch) {
    const cols = createMatch[1].split(/,/).map(c => c.trim().split(/\s+/)[0]).filter(Boolean);
    console.log("表列序(前12):", cols.slice(0, 12).join(", "));
  }
}
// 统计每条 VALUES 的第2列(假设 FangId 在第2位)
const fangIds = new Set();
const sample = [];
for (const l of lines) {
  const m = l.match(/VALUES\s*\(([\s\S]*?)\)\s*;/);
  if (!m) continue;
  // 简化：按顶层逗号切（不经过完整解析，足够看第2列数字）
  const inner = m[1];
  // 用正则找第一个 (...) 子组作为完整行
  const rowMatch = inner.match(/^\(([\s\S]*)\)/);
  const row = rowMatch ? rowMatch[1] : inner;
  const top = [];
  let d = 0, cur = "", ins = false;
  for (const ch of row) {
    if (ins) { if (ch === "'") ins = false; cur += ch; }
    else if (ch === "'") { ins = true; cur += ch; }
    else if (ch === "," && d === 0) { top.push(cur); cur = ""; }
    else if (ch === "(" ) { d++; cur += ch; }
    else if (ch === ")") { d--; cur += ch; }
    else cur += ch;
  }
  top.push(cur);
  const fangId = top[1] ? top[1].trim() : null;
  if (fangId != null) fangIds.add(fangId);
  if (sample.length < 3) sample.push(top.slice(0,3).join(" | "));
}
console.log("distinct 第2列(FangId) 数:", fangIds.size);
console.log("样例前3行(前3列):");
sample.forEach(s => console.log("  ", s));
