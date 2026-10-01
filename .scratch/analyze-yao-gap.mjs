import {readFileSync} from "node:fs";

const load = (p) => JSON.parse(readFileSync(p, "utf8")).data ?? [];
const oldY = load("D:/git/AiCode/microfeed/.scratch/tcm-import/golden/old-1001000/GetAllZhongYao.json");
const newY = load("D:/git/AiCode/microfeed/.scratch/tcm-import/golden/new-1001000-recheck/GetAllZhongYao.json");

const counts = new Map();
for (const x of oldY) counts.set(x.name, (counts.get(x.name) ?? 0) + 1);
const uniq = [...counts.keys()];
console.log("old 601 条中唯一药名数:", uniq.length);
const dupNames = uniq.filter((n) => counts.get(n) > 1);
console.log("重复出现的药名数:", dupNames.length, "| 示例:", dupNames.slice(0, 5).map((n) => n + "x" + counts.get(n)));

// 同一药名多次出现时 text 是否相同
let dupSameText = 0;
let dupDiffText = 0;
for (const n of dupNames) {
  const texts = oldY.filter((x) => x.name === n).map((x) => x.text);
  if (new Set(texts).size === 1) dupSameText++;
  else dupDiffText++;
}
console.log("重复药名里 text 完全相同:", dupSameText, "| text 不同:", dupDiffText);

const newNames = new Set(newY.map((x) => x.name));
const missing = uniq.filter((n) => !newNames.has(n));
console.log("\n本地缺失的唯一药名:", missing.length);
console.log("缺失示例:", missing.slice(0, 15));

// 缺失的药名在 old 里的 text 长度（判断是否有实质内容）
const missingWithText = missing.filter((n) => {
  const e = oldY.find((x) => x.name === n);
  return e && String(e.text ?? "").length > 10;
});
console.log("缺失且有实质 text 的:", missingWithText.length, "/", missing.length);

// 已有 172 味：text 差异统计（old 取该 name 最长的一条）
const newBy = new Map(newY.map((x) => [x.name, x]));
let needFix = 0;
for (const [name, n] of newBy) {
  const entries = oldY.filter((x) => x.name === name);
  const longest = entries.map((x) => String(x.text ?? "")).sort((a, b) => b.length - a.length)[0] ?? "";
  if (longest !== String(n.text ?? "")) needFix++;
}
console.log("\n已存在但 text 需补齐的药味:", needFix, "/", newBy.size);
