import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";

const DB = "D:/git/AiCode/microfeed/.microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/miniflare-D1DatabaseObject/e60aa88374e950a08be5ad11bdf5fb22c7e803a0aa157cfb660080323535bcb8.sqlite";

const parseRows = (path, cols) => {
  const text = readFileSync(path, "utf8");
  const out = [];
  for (const m of text.matchAll(/VALUES\s*\((.*?)\)\s*;/gs)) {
    const vals = splitTop(m[1]);
    if (vals.length >= cols.length) {
      const row = {};
      cols.forEach((c, i) => (row[c] = clean(vals[i])));
      out.push(row);
    }
  }
  return out;
};
const splitTop = (s) => {
  const out = [];
  let cur = "";
  let d = 0;
  let ins = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ins) {
      if (ch === "'") {
        if (s[i + 1] === "'") {
          cur += "''";
          i++;
        } else ins = false;
      }
      cur += ch;
    } else if (ch === "'") {
      ins = true;
      cur += ch;
    } else if (ch === "(") {
      d++;
      cur += ch;
    } else if (ch === ")") {
      d--;
      cur += ch;
    } else if (ch === "," && d === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
};
const clean = (v) => {
  v = v.trim();
  if (v === "NULL") return null;
  if (v.startsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
};
const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const idOwner = new Map();
const tcmId = (kind, sourceKey) => {
  const owner = kind + ":" + sourceKey;
  for (let salt = 0; salt < 8; salt += 1) {
    const digest = createHash("sha256").update(owner + "#" + salt).digest();
    let id = "";
    for (const byte of digest) {
      id += BASE62[byte % 62];
      if (id.length === 11) break;
    }
    const claimed = idOwner.get(id);
    if (claimed === undefined) {
      idOwner.set(id, owner);
      return id;
    }
    if (claimed === owner) return id;
  }
  throw new Error("collision " + owner);
};
// build.ts textToHtml: lossless round-trip, keeps line separators between <p>…</p>
const textToHtml = (text) => {
  if (String(text || "").trim() === "") return "";
  const parts = String(text || "").split(/(\r\n|\r|\n)/); // [line, sep, line, sep, …]
  let out = "";
  for (let i = 0; i < parts.length; i += 2) {
    out += "<p>" + (parts[i] ?? "") + "</p>";
    const sep = parts[i + 1];
    if (sep !== undefined) out += sep;
  }
  return out;
};

const yao = parseRows("D:/git/AiCode/microfeed/ctwh/Yao.sql", ["YaoId", "YaoNo", "YaoName", "YaoBieMing", "YaoText", "YaoList"]);
const aliasRows = parseRows("D:/git/AiCode/microfeed/ctwh/yaoAlias.sql", ["yaoAliasId", "yaoAliasNo", "YaoBieMing", "YaoName"]);
console.log("yaoAlias sample:", JSON.stringify(aliasRows[0] ?? null));

// build.ts alias fold: alias row {bieming: YaoBieMing, name: YaoName} per carrier YaoName
// (post-2026-09-30 fix: carrier resolved via YaoName/YaoList/tokens; alias name = source YaoName)
const yaoNameSet = new Set(yao.map((r) => r.YaoName));
const yaoListTokens = new Map(
  yao.map((r) => [r.YaoName, String(r.YaoList || "").split(/[,，]/).map((s) => s.trim()).filter((s) => s.length > 0)]),
);
const resolveCarrier = (canonical) => {
  if (yaoNameSet.has(canonical)) return canonical;
  for (const [name, tokens] of yaoListTokens) if (tokens.includes(canonical)) return name;
  for (const name of yaoNameSet) if (name.includes(canonical)) return name;
  let best = null;
  let bestLen = 0;
  for (const name of yaoNameSet) {
    let i = 0;
    while (i < canonical.length && i < name.length && canonical[i] === name[i]) i += 1;
    if (i > bestLen) {
      bestLen = i;
      best = name;
    }
  }
  return bestLen > 0 ? best : null;
};
const aliasesByYaoName = new Map();
for (const a of aliasRows) {
  const canonical = a.YaoName;
  const alias = a.YaoBieMing;
  if (!canonical || !alias) continue;
  const carrier = resolveCarrier(String(canonical));
  if (!carrier) continue;
  if (!aliasesByYaoName.has(carrier)) aliasesByYaoName.set(carrier, []);
  aliasesByYaoName.get(carrier).push({bieming: alias, name: canonical});
}

const db = new DatabaseSync(DB, {readOnly: true});
const localYao = db.prepare("SELECT id, data FROM items WHERE tcm_kind='yao'").all().map((r) => {
  const d = JSON.parse(r.data);
  return {id: r.id, title: d.title, bare: String(d.title || "").replace(/^\d+、/, ""), desc: d.description || "", mf: d._microfeed || {}};
});
const byBare = new Map();
for (const y of localYao) byBare.set(y.bare, y);

let idOk = 0;
let idBad = 0;
let descOk = 0;
let descBad = 0;
let noOk = 0;
let noBad = 0;
let aliasOk = 0;
let aliasBad = 0;
const problems = [];
for (const r of yao) {
  // pre-warm per source order so salt allocation matches import
  const computed = tcmId("yao", String(r.YaoId));
  const local = byBare.get(r.YaoName);
  if (!local) continue;
  if (local.id === computed) idOk++;
  else {
    idBad++;
    problems.push({kind: "id", yao: r.YaoName, local: local.id, computed});
  }
  // no
  const srcNo = r.YaoNo;
  const localNo = local.mf.no;
  if (String(srcNo) === String(localNo)) noOk++;
  else {
    noBad++;
    if (noBad <= 5) problems.push({kind: "no", yao: r.YaoName, src: srcNo, local: localNo});
  }
  // description: semantic compare — strip tags/escaped+real newlines/whitespace,
  // because source stores literal "\r\n" escapes while local stores real line
  // breaks between <p> segments.
  const strip = (s) =>
    String(s || "")
      .replace(/<[^>]*>/g, "")
      .replace(/\\r\\n|\\r|\\n|\r\n|\r|\n/g, "")
      .replace(/\s+/g, "");
  const expectedPlain = strip(r.YaoText);
  const localPlain = strip(local.desc);
  if (localPlain === expectedPlain) descOk++;
  else {
    descBad++;
    if (descBad <= 5) {
      let firstDiff = -1;
      for (let i = 0; i < Math.max(localPlain.length, expectedPlain.length); i++) {
        if (localPlain[i] !== expectedPlain[i]) {
          firstDiff = i;
          break;
        }
      }
      problems.push({
        kind: "desc",
        yao: r.YaoName,
        lenSrc: expectedPlain.length,
        lenLocal: localPlain.length,
        firstDiff,
        srcAt: expectedPlain.slice(Math.max(0, firstDiff - 20), firstDiff + 40),
        localAt: localPlain.slice(Math.max(0, firstDiff - 20), firstDiff + 40),
      });
    }
  }
  // aliases (compare bieming lists, order-insensitive)
  const expectedAliases = (aliasesByYaoName.get(r.YaoName) || []).map((a) => a.bieming);
  const localAliases = Array.isArray(local.mf.aliases) ? local.mf.aliases.map((a) => (typeof a === "string" ? a : a.bieming)) : [];
  const sortedSame = JSON.stringify([...expectedAliases].sort()) === JSON.stringify([...localAliases].sort());
  if (sortedSame) aliasOk++;
  else {
    aliasBad++;
    if (aliasBad <= 5) problems.push({kind: "alias", yao: r.YaoName, src: expectedAliases, local: localAliases});
  }
}

console.log("==== yao 全量核对（172）====");
console.log("id 推导一致:", idOk + "/" + (idOk + idBad), "| 不一致:", idBad);
console.log("no 一致:", noOk + "/" + (noOk + noBad), "| 不一致:", noBad);
console.log("正文(description)一致:", descOk + "/" + (descOk + descBad), "| 不一致:", descBad);
console.log("别名(aliases)一致:", aliasOk + "/" + (aliasOk + aliasBad), "| 不一致:", aliasBad);
console.log("--- problems ---");
console.log(JSON.stringify(problems.slice(0, 20), null, 1));
db.close();
