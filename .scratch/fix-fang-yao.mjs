import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";

const DB = "D:/git/AiCode/microfeed/.microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/miniflare-D1DatabaseObject/e60aa88374e950a08be5ad11bdf5fb22c7e803a0aa157cfb660080323535bcb8.sqlite";
const APPLY = process.argv.includes("--apply");

// ---- parse MySQL dump ----
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
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
// replicate build.ts tcmId with the same idOwner pre-warm order (YaoId ascending)
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

const yao = parseRows("D:/git/AiCode/microfeed/ctwh/Yao.sql", ["YaoId", "YaoNo", "YaoName", "YaoBieMing", "YaoText", "YaoList"]);
const fb = parseRows("D:/git/AiCode/microfeed/ctwh/FangBody.sql", ["FangBodyId", "FangId", "Amount", "YaoID", "Weight", "Suffix", "ShowName", "ExtraProcess"]);
const byYaoId = new Map(yao.map((r) => [Number(r.YaoId), r.YaoName]));
// pre-warm idOwner in YaoId order (matches import)
for (const r of yao) tcmId("yao", String(r.YaoId));

const db = new DatabaseSync(DB, {readOnly: !APPLY});
// local yao by bare title + by computed id
const localYao = db
  .prepare("SELECT id, data FROM items WHERE tcm_kind='yao'")
  .all()
  .map((r) => {
    const d = JSON.parse(r.data);
    return {id: r.id, title: d.title, bare: String(d.title || "").replace(/^\d+、/, "")};
  });
const yaoByBare = new Map();
for (const y of localYao) {
  if (y.bare) {
    if (yaoByBare.has(y.bare)) yaoByBare.get(y.bare).push(y.id);
    else yaoByBare.set(y.bare, [y.id]);
  }
}

console.log("==== 核对 172 味中药 ====");
console.log("本地 yao 条目数:", localYao.length, "| 源 Yao 表:", yao.length);
const missing = [];
const dup = [];
const idMismatch = [];
for (const r of yao) {
  const computed = tcmId("yao", String(r.YaoId));
  const matches = yaoByBare.get(r.YaoName) || [];
  if (matches.length === 0) missing.push(r.YaoName);
  else if (matches.length > 1) dup.push(r.YaoName + " x" + matches.length);
  if (matches.length === 1 && matches[0] !== computed) idMismatch.push({yao: r.YaoName, byName: matches[0], computed});
}
console.log("标题无法匹配的:", missing.length, missing.slice(0, 10));
console.log("标题重复(同裸名多条目):", dup.length, dup.slice(0, 5));
console.log("标题匹配id≠tcmId推导:", idMismatch.length, JSON.stringify(idMismatch.slice(0, 5)));

console.log("\n==== 修复 7 个方剂 yaoId (dry-run) ====");
const fangRows = parseRows("D:/git/AiCode/microfeed/ctwh/Fang.sql", ["FangId", "FangName"]);
const fangTitle = (fid) => {
  const f = fangRows.find((x) => x.FangId === String(fid));
  return f ? f.FangName : "?";
};
const guilinFangs = [...new Set(fb.filter((r) => {
  const n = Number(r.FangId);
  return n >= 426 && n <= 754;
}).map((r) => r.FangId))].sort((a, b) => Number(a) - Number(b));
console.log("guilin fangs with body:", guilinFangs.length, guilinFangs.join(","));
let checksOk = 0;
let checksBad = 0;
const badRows = [];
const plans = [];
for (const fid of guilinFangs) {
  const no = Number(fid) - 425; // local no = FangId - 425
  const rows = fb.filter((r) => r.FangId === fid).sort((a, b) => Number(a.FangBodyId) - Number(b.FangBodyId));
  const newList = rows.map((r) => {
    const corrected = Number(r.YaoID) + 1;
    const expectName = byYaoId.get(corrected);
    const bareHits = expectName ? (yaoByBare.get(expectName) || []) : [];
    const localId = bareHits.length === 1 ? bareHits[0] : null;
    if (localId && expectName && expectName !== r.ShowName) badRows.push({fid, shown: r.ShowName, expectName, corrected});
    if (localId) checksOk++;
    else checksBad++;
    return {
      yaoId: localId,
      amount: r.Amount ?? null,
      weight: r.Weight ?? null,
      suffix: r.Suffix ?? null,
      showName: r.ShowName ?? "",
      extraProcess: r.ExtraProcess ?? null,
    };
  });
  plans.push({no, fid, title: fangTitle(fid), count: rows.length, newList, yaoIds: newList.map((x) => x.yaoId)});
}
for (const p of plans) {
  console.log("no=" + p.no + " (FangId=" + p.fid + ") " + p.title + ": " + p.count + " 味 -> yaoId: " + p.yaoIds.join(", "));
}
console.log("\n校验: yaoId 能解析且名字对上的行:", checksOk, "| 有问题的行:", checksBad, JSON.stringify(badRows.slice(0, 5)));

if (APPLY) {
  console.log("\n==== APPLY ====");
  const stmt = db.prepare("UPDATE items SET data = ?, updated_at = ? WHERE id = ?");
  let applied = 0;
  for (const p of plans) {
    const local = db.prepare("SELECT id, data FROM items WHERE tcm_kind='fang' AND json_extract(data,'$._microfeed.no')=?").get(p.no);
    if (!local) {
      console.log("no=", p.no, "本地方剂未找到");
      continue;
    }
    const d = JSON.parse(local.data);
    d._microfeed.fangYaoList = p.newList;
    stmt.run(JSON.stringify(d), new Date().toISOString(), local.id);
    applied++;
  }
  console.log("applied fangs:", applied);
}
db.close();
