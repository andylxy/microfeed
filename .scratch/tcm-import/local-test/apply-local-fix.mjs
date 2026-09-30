#!/usr/bin/env node
// 在本地实例的 local-state D1 上套用与远端 fix-rename-channel.sql 同构的修复：
// 把 q6u5siNb2hT 频道名由「伤寒金匮・(宋版)」正名为「伤寒论・(宋版)」。
// 本地是普通 sqlite 文件，直接改，不耗 D1 配额、不走 wrangler。
import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const INSTANCE = process.argv[2] || "ctwh-local";
const ROOT = join(".microfeed", "instances", INSTANCE, "local-state", "v3", "d1", "miniflare-D1DatabaseObject");

function findSqlite(dir) {
  // 取最大的那个 .sqlite（metadata.sqlite 很小，数据文件较大）
  const files = readdirSync(dir).filter((f) => f.endsWith(".sqlite"));
  const data = files.filter((f) => f !== "metadata.sqlite").sort();
  return data[data.length - 1];
}

const p = join(ROOT, findSqlite(ROOT));
console.log("target sqlite:", p);
const db = new DatabaseSync(p);

// 1) 看改前
const before = db.prepare("SELECT id, json_extract(data,'$.title') AS title FROM channels WHERE id='q6u5siNb2hT'").get();
console.log("BEFORE:", JSON.stringify(before));

// 2) 同构修复（与 .scratch/tcm-import/fix-rename-channel.sql 一致）
const res = db.prepare(
  `UPDATE channels SET data = json_set(data, '$.title', '伤寒论・(宋版)') WHERE id = 'q6u5siNb2hT'`
).run();
console.log("UPDATE affected rows:", res.changes);

// 3) 看改后
const after = db.prepare("SELECT id, json_extract(data,'$.title') AS title FROM channels WHERE id='q6u5siNb2hT'").get();
console.log("AFTER :", JSON.stringify(after));

// 4) 顺带确认「伤寒金匮」字样已消失
const residual = db.prepare("SELECT COUNT(*) c FROM channels WHERE json_extract(data,'$.title') LIKE '%伤寒金匮%'").get().c;
console.log("channels still containing 伤寒金匮:", residual);
db.close();
