import {readdirSync} from "node:fs";
import {join, resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";

function rawParagraphText(html: string): string {
  const source = String(html ?? "");
  const paragraphs = [...source.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
  if (paragraphs.length === 0) return source;
  return paragraphs.join("\n");
}
const dir = resolve(".microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/miniflare-D1DatabaseObject");
const file = join(dir, readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")!);
const db = new DatabaseSync(file, {readOnly: true});
const rows = db.prepare("SELECT id, data FROM items WHERE tcm_kind='yao' AND status=1 ORDER BY id").all() as Array<{id: string; data: string}>;
const out = rows.map((row) => {
  const data = JSON.parse(String(row.data ?? "{}"));
  const text = rawParagraphText(typeof data.description === "string" ? data.description : "");
  return {YaoName: String(data.title ?? ""), YaoText: text, AllYaoText: text, YaoEnum: "0"};
});
const json = JSON.stringify(out);
console.log("rows:", out.length, "json bytes:", json.length);
// 找可疑字符
for (let i = 0; i < out.length; i += 1) {
  const t = out[i].YaoText;
  for (let j = 0; j < t.length; j += 1) {
    const code = t.charCodeAt(j);
    if (code >= 0xD800 && code <= 0xDFFF && !(code >= 0xD800 && code <= 0xDBFF && j + 1 < t.length && t.charCodeAt(j + 1) >= 0xDC00 && t.charCodeAt(j + 1) <= 0xDFFF)) {
      console.log("可疑代理字符 row", i, out[i].YaoName, "pos", j, code.toString(16));
    }
  }
}
console.log("样例[0]:", JSON.stringify(out[0]).slice(0, 120));
console.log("样例含畏:", JSON.stringify(out.find((o) => o.YaoName.includes("畏")))?.slice(0, 160));
