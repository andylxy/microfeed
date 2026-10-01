// 双本地库重灌工具（node:sqlite 直读直写，绕开沙箱嵌套 spawn EBUSY）。
// 用法：node --import tsx .scratch/tcm-import/repour.mts <instance> <state-dir> [out-dir]
//   <state-dir> ∈ ".wrangler/state" | "local-state"
//   <out-dir>    默认 ".scratch/tcm-import/out"；按需导入时传 ctwh-books/<BookNo>/out
// 幂等：批次 SQL 全部 INSERT OR REPLACE，重跑不翻倍。
import {DatabaseSync} from "node:sqlite";
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";

const instance = process.argv[2];
const stateDir = process.argv[3];
const outDir = process.argv[4] ?? ".scratch/tcm-import/out";
if (!instance || !stateDir) {
  console.error("用法：node --import tsx .scratch/tcm-import/repour.mts <instance> <state-dir> [out-dir]");
  process.exit(1);
}
console.error("OUT_DIR = " + outDir);

const d1Dir = join(
  ".microfeed/instances",
  instance,
  stateDir,
  "v3/d1/miniflare-D1DatabaseObject",
);
const dbFile = readdirSync(d1Dir).find(
  (file) => file.endsWith(".sqlite") && file !== "metadata.sqlite",
);
if (!dbFile) throw new Error(`未找到本地 D1 sqlite：${d1Dir}`);
const db = new DatabaseSync(join(d1Dir, dbFile));
// INSERT OR REPLACE 的隐式删除默认不触发 DELETE 触发器（recursive_triggers 默认 OFF），
// 会在 site_search_documents/FTS 留孤儿行（2026-09-29 审计发现）——必须显式打开。
db.exec("PRAGMA recursive_triggers=ON;");

// 注意：outDir 取自命令行第 4 参（按需导入时传 ctwh-books/<BookNo>/out），
// 不要在此硬编码覆盖（此前曾被同名 const 覆盖导致 per-book 目录失效）。
const files = ["tcm-channels.sql"].concat(
  readdirSync(outDir)
    .filter((f) => /^tcm-batch-\d+\.sql$/.test(f))
    .sort(),
);
for (const file of files) {
  db.exec(readFileSync(join(outDir, file), "utf8"));
}

const counts = db
  .prepare(
    "SELECT tcm_kind, COUNT(*) AS n FROM items WHERE tcm_kind IS NOT NULL GROUP BY tcm_kind ORDER BY tcm_kind",
  )
  .all();
const caseSample = db
  .prepare(
    "SELECT json_extract(data,'$._microfeed.case') AS c FROM channels WHERE json_extract(data,'$._microfeed.case') IS NOT NULL LIMIT 3",
  )
  .all();
const termSample = db
  .prepare(
    "SELECT json_extract(data,'$._microfeed.mingCiList') AS m FROM items WHERE tcm_kind='term' AND json_extract(data,'$._microfeed.mingCiList') != '' LIMIT 2",
  )
  .all();
const yaoNamesCount = db
  .prepare(
    "SELECT COUNT(*) AS n FROM items WHERE tcm_kind='yao' AND json_extract(data,'$._microfeed.yaoNames') != ''",
  )
  .get();
const bieMingCount = db
  .prepare(
    "SELECT COUNT(*) AS n FROM items WHERE tcm_kind='section' AND json_extract(data,'$._microfeed.bieMing') != ''",
  )
  .get();
console.log(
  JSON.stringify(
    {applied: files.length, counts, caseSample, termSample, yaoNamesCount, bieMingCount},
    null,
    2,
  ),
);
