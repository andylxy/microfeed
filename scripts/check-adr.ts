/**
 * 校验 microfeed 仓库的 ADR（Architecture Decision Record）规范性。
 *
 * 共强制四条规则：
 *   1. 编号在 `docs/novel-cms/adr/` 内唯一。文件名前缀 `NNNN-` 与 H1 中的
 *      `ADR-NNNN:` 必须一致，且任意两个文件不得共用同一编号。`ADR-0002` 在
 *      2026-10-12 之前被两篇不同 ADR 共用（作者隔离 vs D1 读路径优化），规则 1 正是为拦住这种情况。
 *   2. 每篇 H1 必须以 `# ADR-NNNN:` 开头。历史上的 ADR（0007、0014）发布时
 *      缺此前缀；门禁拦截回归。
 *   3. `src/` 与 `migrations/` 中的裸 `ADR-NNNN` 引用必须能解析到实际文件。
 *      有两处决策编号来自本仓库未收录的规范，由下方 `OUT_OF_REPO_REFS` 豁免
 *      （都写作 `ADR-001 D-010` / `D-011`，位于 `src/server/rbac/guard.ts`）；
 *      另有第三种写法 `ADR D-010`（位于 `src/server/admin/rbac-handlers.ts:318`）：
 *      扫描正则同样会匹配它，但从中提取出的标识是 `D-010` 而非 3–4 位数字编号，
 *      因此规则判定其无法解析而跳过——它不需要列入 `OUT_OF_REPO_REFS`。
 *   4. 生产代码（`src/`、`migrations/`）不得引用任何 `.scratch/<anything>/adr/*.md`
 *      路径。此类路径是草稿 ADR；生产代码必须指向 `docs/novel-cms/adr/`。
 *      其他 `.scratch/` 路径（spec、OPS、fixtures、scripts）不在本门禁范围内。
 *
 * 用 `yarn adr:check` 运行。任意规则被违反时以非零状态退出。
 */
import {readdirSync, readFileSync, existsSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {report, walk, finish} from "./gate-utils";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const adrRoot = path.join(repositoryRoot, "docs", "novel-cms", "adr");

// 引用了本仓库未收录规范中的决策编号。评审记录在
// `.scratch/microfeed-rbac/rbac-change-review-2026-09-23.md:22`（"所引 ADR 不在本仓，无法核对"）。
//
// 只需列出零填充写法：`ADR-001 D-010` 提取出的编号是 001，下方规则会按 ADR 0001
// 去查找，因文件命名为 `0001-…` 而查不到，被报为无法解析，故需在此豁免。
// 非零填充的 `ADR D-010`（`src/server/admin/rbac-handlers.ts:318`）提取出的标识是
// `D-010`，不是 3–4 位数字编号，扫描逻辑会直接跳过它，因此无需列入此处——
// 列入反而会成为一条永远走不到的分支。
const OUT_OF_REPO_REFS = new Set([
  "ADR-001 D-010",
  "ADR-001 D-011",
]);

// 规则 1 + 2：枚举 ADR 文件，检查编号唯一性与 H1 前缀。
const adrFiles = existsSync(adrRoot)
  ? readdirSync(adrRoot).filter((name) => name.endsWith(".md"))
  : [];
const numbers = new Map<string, string[]>();
for (const name of adrFiles) {
  const match = name.match(/^(\d{4})-/);
  if (!match) {
    report(
      `docs/novel-cms/adr/${name}`,
      "ADR-001",
      `file name must start with a 4-digit number, e.g. 0007-`,
    );
    continue;
  }
  const number = match[1];
  const existing = numbers.get(number) ?? [];
  existing.push(name);
  numbers.set(number, existing);

  const absolute = path.join(adrRoot, name);
  const source = readFileSync(absolute, "utf8");
  const firstLine = source.split(/\r?\n/)[0] ?? "";
  if (!firstLine.startsWith(`# ADR-${number}:`)) {
    report(
      `docs/novel-cms/adr/${name}`,
      "ADR-002",
      `H1 must be \`# ADR-${number}:\`, found: ${JSON.stringify(firstLine.slice(0, 60))}`,
    );
  }
}
for (const [number, names] of numbers) {
  if (names.length > 1) {
    for (const name of names) {
      report(
        `docs/novel-cms/adr/${name}`,
        "ADR-001",
        `ADR number ${number} is used by ${names.length} files: ${names.join(", ")}`,
      );
    }
  }
}

// 规则 3 + 4：扫描 src/ 与 migrations/ 中的 ADR 引用。
const productionFiles = [
  ...walk(path.join(repositoryRoot, "src"), (name) => /\.tsx?$/u.test(name)),
  ...walk(path.join(repositoryRoot, "migrations"), (name) => name.endsWith(".sql")),
];

// 匹配 `ADR-0002`、`ADR-001 D-010`，以及非零填充的 `ADR D-010`。连字符与编号
// 均为可选，因此非零填充写法也能被匹配；既无连字符也无编号的裸 `ADR` 在下方被过滤掉。
const refPattern = /ADR(?:-\d{1,4})?(?:\s+D-\d{3})?/g;
const scratchPathPattern = /\.scratch\/[^"'`)\s]*\/adr\/[^"'`)\s]+\.md/g;
for (const file of productionFiles) {
  const source = readFileSync(file, "utf8");
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match: RegExpExecArray | null;
    refPattern.lastIndex = 0;
    while ((match = refPattern.exec(line)) !== null) {
      const ref = match[0];
      if (OUT_OF_REPO_REFS.has(ref)) continue;
      // 裸 `ADR`（或 `ADR D-...` 这类提取不出数字编号的写法）是散文，不是引用。
      const number = ref.slice(3).replace(/^-/u, "").split(" ")[0];
      if (!/^\d{3,4}$/u.test(number)) continue;
      const hasFile = adrFiles.some((name) => name.startsWith(`${number}-`));
      if (!hasFile) {
        report(
          path.relative(repositoryRoot, file),
          "ADR-003",
          `reference to ${ref} does not resolve to a file in docs/novel-cms/adr/`,
          i + 1,
        );
      }
    }
    scratchPathPattern.lastIndex = 0;
    while ((match = scratchPathPattern.exec(line)) !== null) {
      report(
        path.relative(repositoryRoot, file),
        "ADR-004",
        `production code must not reference ${match[0]}; use a docs/novel-cms/adr/ path`,
        i + 1,
      );
    }
  }
}

finish("ADR hygiene");

console.log(`OK: ${adrFiles.length} ADR files, ${numbers.size} unique numbers, ${productionFiles.length} production files scanned.`);
