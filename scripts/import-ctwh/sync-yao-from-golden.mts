/**
 * 把 netcoer（旧后端）GetAllZhongYao 的 601 味中药同步进本地库。
 *
 * 为什么需要这一步：`ctwh/Yao.sql` 只有 172 行，且不含《神农本草经疏》
 * 条目正文（实测 滑石 YaoText=259 字，netcoer=1664 字）。旧端 601 味 =
 * 172（Yao.sql）∪ 429（只见于旧端活库）。要让两个后端 GetAllZhongYao
 * 返回一致，只能以旧端返回为数据源。
 *
 * 策略（不破坏既有引用）：
 * - 已存在的同名药（172 味）：**只更新正文与排序号，保留原 11 位 id**
 *   （方剂组成 `fangYaoList[].yaoId` 仍指向它们）。
 * - 旧端独有（429 味）：新建 yao 条目，id 由 tcmId("yao", ...) 确定性推导。
 * - 排序号 `_microfeed.no` 一律改为旧端返回顺序，保证顺序也与旧端一致。
 *
 * 用法：
 *   node --import tsx scripts/import-ctwh/sync-yao-from-golden.mts \
 *     --db ".microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite"
 */
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {textToHtml, tcmId, htmlToPlain} from "./build";

const ROOT = resolve(import.meta.dirname, "../..");

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dbPath = argValue("--db");
if (!dbPath) {
  console.error("缺少 --db <sqlite 路径>");
  process.exit(1);
}

const CONTAINER_YAO = "tcmyao00001";

interface ZhongYao {
  name: string;
  text: string;
}

const golden = JSON.parse(
  readFileSync(`${ROOT}/.scratch/tcm-import/golden/old/GetAllZhongYao.json`, "utf8"),
) as {data?: ZhongYao[]};
const list = golden.data ?? [];
console.log(`旧端 GetAllZhongYao：${list.length} 味`);

const db = new DatabaseSync(resolve(ROOT, dbPath));

const findStmt = db.prepare(
  "SELECT id, data FROM items WHERE tcm_kind = 'yao' " +
    "AND json_extract(data, '$.title') = ?",
);

let updated = 0;
let inserted = 0;
const now = new Date().toISOString();

db.exec("BEGIN");
try {
  list.forEach((entry, index) => {
    const name = String(entry.name ?? "").trim();
    if (!name) return;
    const description = textToHtml(String(entry.text ?? ""));
    const existing = findStmt.get(name) as {id: string; data: string} | undefined;

    if (existing) {
      // 保留 id，更新正文 + 排序号（顺序对齐旧端）
      const next = db
        .prepare(
          "UPDATE items SET data = json_set(json_set(json_set(data, " +
            "'$.description', ?), '$.content_format', 'html'), " +
            "'$._microfeed.no', ?) WHERE id = ?",
        )
        .run(description, index, existing.id);
      updated += next.changes;
      return;
    }

    const id = tcmId("yao", `netcoer:${name}`);
    const data = JSON.stringify({
      title: name,
      description,
      content_format: "html",
      _microfeed: {
        bookId: CONTAINER_YAO,
        no: index,
        // 来源标记：这 429 味在 ctwh dump 里没有，取自旧端返回。
        source: "netcoer",
      },
    });
    db.prepare(
      "INSERT OR REPLACE INTO items " +
        "(id, status, tcm_kind, tcm_parent_id, book_id, data, content_text, " +
        " pub_date, created_at, updated_at) " +
        "VALUES (?, 1, 'yao', NULL, ?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      CONTAINER_YAO,
      data,
      htmlToPlain(description),
      now,
      now,
      now,
    );
    inserted += 1;
  });
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

const total = db
  .prepare("SELECT COUNT(*) n FROM items WHERE tcm_kind = 'yao' AND status != 3")
  .get() as {n: number};
console.log(`已更新(原有): ${updated}`);
console.log(`新建(旧端独有): ${inserted}`);
console.log(`库中 yao 总数: ${total.n}（目标 601）`);
