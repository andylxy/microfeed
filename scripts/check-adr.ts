/**
 * Verifies ADR (Architecture Decision Record) hygiene for the microfeed repo.
 *
 * Four rules are enforced:
 *   1. Numbering is unique across `docs/novel-cms/adr/`. The `NNNN-` prefix of
 *      the file name and the `ADR-NNNN:` in the H1 must match, and no two
 *      files may share the same number. `ADR-0002` was held by two different
 *      ADRs (作者隔离 vs D1 读路径优化) until 2026-10-12; rule 1 blocks that.
 *   2. Every H1 must start with `# ADR-NNNN:`. Historical ADRs were shipped
 *      without the prefix (0007, 0014); the gate blocks regressions.
 *   3. Bare `ADR-NNNN` references in `src/` and `migrations/` must resolve to
 *      an existing file. Four out-of-repo references are exempted by
 *      `OUT_OF_REPO_REFS` below: `ADR-001 D-010` (twice), `ADR-001 D-011`
 *      (both in `src/server/rbac/guard.ts`) and `ADR D-010` (in
 *      `src/server/admin/rbac-handlers.ts`) come from a spec this repo does
 *      not carry — see `.scratch/microfeed-rbac/rbac-change-review-2026-09-23.md`.
 *   4. Production code (`src/`, `migrations/`) must not reference any
 *      `.scratch/<anything>/adr/*.md` path. Those are draft ADRs; production
 *      code must point at `docs/novel-cms/adr/`. Other `.scratch/` paths
 *      (spec, OPS, fixtures, scripts) are out of this gate's scope.
 *
 * Run with `yarn adr:check`. It exits non-zero when any rule is violated.
 */
import {readdirSync, readFileSync, existsSync, statSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const adrRoot = path.join(repositoryRoot, "docs", "novel-cms", "adr");

type Finding = {file: string; line: number; rule: string; message: string};

function walk(directory: string, extensions: string[], out: string[] = []): string[] {
  if (!existsSync(directory)) return out;
  for (const name of readdirSync(directory)) {
    const entry = path.join(directory, name);
    if (statSync(entry).isDirectory()) walk(entry, extensions, out);
    else if (extensions.some((ext) => name.endsWith(ext))) out.push(entry);
  }
  return out;
}

// References to a decision id from a spec this repo does not carry. The
// reviewer recorded them in
// `.scratch/microfeed-rbac/rbac-change-review-2026-09-23.md:22` ("所引 ADR
// 不在本仓，无法核对"). Two spellings exist for the same id: `guard.ts` writes
// the zero-padded `ADR-001 D-010` / `D-011`, while
// `src/server/admin/rbac-handlers.ts:318` writes the unpadded `ADR D-010`.
// Both must be listed or the unpadded one is reported as unresolvable.
const OUT_OF_REPO_REFS = new Set([
  "ADR-001 D-010",
  "ADR-001 D-011",
  "ADR D-010",
  "ADR D-011",
]);

const findings: Finding[] = [];

// Rule 1 + 2: enumerate ADR files, check number uniqueness and H1 prefix.
const adrFiles = existsSync(adrRoot)
  ? readdirSync(adrRoot).filter((name) => name.endsWith(".md"))
  : [];
const numbers = new Map<string, string[]>();
for (const name of adrFiles) {
  const match = name.match(/^(\d{4})-/);
  if (!match) {
    findings.push({
      file: `docs/novel-cms/adr/${name}`,
      line: 1,
      rule: "ADR-001",
      message: `file name must start with a 4-digit number, e.g. 0007-`,
    });
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
    findings.push({
      file: `docs/novel-cms/adr/${name}`,
      line: 1,
      rule: "ADR-002",
      message: `H1 must be \`# ADR-${number}:\`, found: ${JSON.stringify(firstLine.slice(0, 60))}`,
    });
  }
}
for (const [number, names] of numbers) {
  if (names.length > 1) {
    for (const name of names) {
      findings.push({
        file: `docs/novel-cms/adr/${name}`,
        line: 1,
        rule: "ADR-001",
        message: `ADR number ${number} is used by ${names.length} files: ${names.join(", ")}`,
      });
    }
  }
}

// Rule 3 + 4: scan src/ and migrations/ for ADR references.
const productionFiles = [
  ...walk(path.join(repositoryRoot, "src"), [".ts", ".tsx"]),
  ...walk(path.join(repositoryRoot, "migrations"), [".sql"]),
];

// Matches `ADR-0002`, `ADR-001 D-010`, and the unpadded `ADR D-010`. The
// hyphen and the number are both optional so the unpadded decision-id form is
// seen rather than silently skipped; a bare `ADR` with neither is filtered out
// below.
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
      // `ADR` alone (or `ADR D-...` with no number) is prose, not a citation.
      const number = ref.slice(3).replace(/^-/u, "").split(" ")[0];
      if (!/^\d{3,4}$/u.test(number)) continue;
      const hasFile = adrFiles.some((name) => name.startsWith(`${number}-`));
      if (!hasFile) {
        findings.push({
          file: path.relative(repositoryRoot, file),
          line: i + 1,
          rule: "ADR-003",
          message: `reference to ${ref} does not resolve to a file in docs/novel-cms/adr/`,
        });
      }
    }
    scratchPathPattern.lastIndex = 0;
    while ((match = scratchPathPattern.exec(line)) !== null) {
      findings.push({
        file: path.relative(repositoryRoot, file),
        line: i + 1,
        rule: "ADR-004",
        message: `production code must not reference ${match[0]}; use a docs/novel-cms/adr/ path`,
      });
    }
  }
}

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line} [${finding.rule}] ${finding.message}`);
  }
  console.error(`\n${findings.length} ADR hygiene violation(s).`);
  process.exit(1);
}

console.log(`OK: ${adrFiles.length} ADR files, ${numbers.size} unique numbers, ${productionFiles.length} production files scanned.`);
