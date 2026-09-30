// 覆盖核对（小批量）：确认 §16 的每条关系在小批量里都出现过。
// 运行：node --import tsx .scratch/tcm-import/coverage.mts [--full]
import {readFileSync} from "node:fs";
import {join, resolve} from "node:path";

import {iterInsertRows} from "../../scripts/import-ctwh/parse";
import {buildTargets, type SourceTables} from "../../scripts/import-ctwh/build";

const root = resolve(import.meta.dirname, "../..");
const sourceDir = join(root, "ctwh");
const full = process.argv.includes("--full");
const limit = full ? null : 20;

const files: Array<[string, keyof SourceTables]> = [
  ["WorkInfo.sql", "work"],
  ["Book.sql", "book"],
  ["BookBody.sql", "bookBody"],
  ["Fang.sql", "fang"],
  ["FangBody.sql", "fangBody"],
  ["Yao.sql", "yao"],
  ["yaoAlias.sql", "yaoAlias"],
  ["MingCi.sql", "mingCi"],
];
const tables: SourceTables = {
  work: [], book: [], bookBody: [], fang: [],
  fangBody: [], yao: [], yaoAlias: [], mingCi: [],
};
for (const [file, key] of files) {
  tables[key] = [...iterInsertRows(readFileSync(join(sourceDir, file), "utf8"))];
}

const {channels, items, report} = buildTargets(tables, limit);
const chapterIds = new Set(items.filter((i) => i.tcmKind === "chapter").map((i) => i.id));
const sections = items.filter((i) => i.tcmKind === "section");
const chapterBooks = new Set(items.filter((i) => i.tcmKind === "chapter").map((i) => i.bookId));
const fangSources = new Set(
  items
    .filter((i) => i.tcmKind === "fang")
    .map((i) => (i.data as any)._microfeed.sourceBookId)
    .filter((v) => v != null),
);
const sectionParentsMissing = sections.filter(
  (s) => !s.tcmParentId || !chapterIds.has(s.tcmParentId),
).length;
const containerIds = new Set(["tcmfang0001", "tcmyao00001", "tcmterm0001"]);

console.log(JSON.stringify({
  mode: full ? "full" : "small",
  channels: channels.length,
  itemsByKind: report.itemsByKind,
  关系覆盖: {
    "①典籍频道→篇章": `${chapterBooks.size} 个频道`,
    "②篇章→条文": `tcm_parent_id 全部可解析：${sectionParentsMissing === 0}`,
    "③来源典籍→方剂": `${fangSources.size} 个频道`,
    "⑥容器频道": `${new Set(items.filter((i) => i.bookId && containerIds.has(i.bookId)).map((i) => i.bookId)).size} 个容器有内容`,
  },
  标记: `${report.markerCountSource}=${report.markerCountOutput}`,
  残留转义: report.residualEscapes,
  警告: report.warnings,
}, null, 2));
