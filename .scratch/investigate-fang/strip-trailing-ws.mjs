import { readFileSync, writeFileSync } from "node:fs";

const p = "D:/git/AiCode/microfeed/.scratch/tcm-import/api-test-plan.md";
const s = readFileSync(p, "utf8");
const lines = s.split("\n");
let n = 0;
const out = lines.map((l) => {
  const t = l.replace(/[ \t]+$/, "");
  if (t.length !== l.length) n++;
  return t;
});
writeFileSync(p, out.join("\n"), "utf8");
console.log("stripped trailing whitespace lines:", n);
