import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

// 主题安装 / 主题写库必须使用绑定参数（SQL 里只写 `?` 占位，值经
// `.bind(...)` / `queryD1WithParameters(...)` 传），严禁把 `bundle_json` 等大列
// 以模板插值拼进 SQL 字面量。
//
// 原因（量化）：D1 对单条 SQL 语句的字面量长度有上限，实测约 100KB（75KB 可通过、
// 135KB 报 `SQLITE_TOOBIG`）。中文主题 `feed-zh` 单个 bundle_json 达 125KB，按
// 字面量拼必失败；绑定参数不计入 SQL 文本长度，可正常入库。
//
// 优化优先级：最高（见 AGENTS.md「主题安装 / 主题写库必须用绑定参数」）。
const THEME_WRITE_FILES = [
  path.join("src", "server", "themes", "ThemeStore.ts"),
  path.join("manage-cli", "theme.ts"),
];
const THEME_INSERT =
  /INSERT(?:\s+OR\s+(?:IGNORE|REPLACE))?\s+INTO\s+(?:themes|theme_drafts)\b/gi;

// 取每条写 themes / theme_drafts 的整段 INSERT SQL：从 `INSERT` 关键字到其所在
// 模板字面量的收尾反引号（跳过 SQL 内部 `'bundled'` 之类的单引号常量）。
function themeInsertSql(source: string): string[] {
  const sqls: string[] = [];
  let match: RegExpExecArray | null;
  THEME_INSERT.lastIndex = 0;
  while ((match = THEME_INSERT.exec(source))) {
    const start = match.index + match[0].length;
    const after = source.slice(start);
    const backtick = after.indexOf("`");
    const doubleQuote = after.indexOf('"');
    let end = start + 800;
    if (backtick !== -1) end = start + backtick;
    else if (doubleQuote !== -1) end = start + doubleQuote;
    sqls.push(source.slice(match.index, end));
  }
  return sqls;
}

describe("theme install uses bound parameters (optimization priority: highest)", () => {
  for (const rel of THEME_WRITE_FILES) {
    it(`${rel} never interpolates theme rows into SQL literals`, async () => {
      const source = await readFile(path.join(repositoryRoot, rel), "utf8");
      const sqls = themeInsertSql(source);
      expect(sqls.length, "expected theme INSERT statements to guard").toBeGreaterThan(0);
      for (const sql of sqls) {
        expect(
          sql,
          "theme INSERT must use ? placeholders + bind, never ${...} literals (bundle_json can hit D1 ~100KB per-statement cap)",
        ).not.toMatch(/\$\{/);
      }
    });
  }
});
