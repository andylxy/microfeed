/**
 * D1 全表扫描量化门禁（microfeed-gate-subset 的第五项检查）。
 *
 * 设计目标：把 d1-full-scan-audit 技能的方法论固化为一个**只读、可重复、可判定**
 * 的门禁——本地 D1 就是磁盘上的一个 sqlite 文件，直接 `node:sqlite` 只读分析，
 * 无需起服务。输出与另外四个架构门禁一致的量化口径，并按 AGENTS.md「最高指令」
 * 给出全表扫描的完整量化字段：当前扫描行数、当前读取字节数、修复后预计读取
 * 字节数的算式与数据缺口、候选索引定义。
 *
 * 判定口径（与 d1-full-scan-audit 一致）：
 *   - `SCAN <表>` 且不含 `USING INDEX` = 真·全表扫描（D1SCAN-001）。无 WHERE 的
 *     整表 `DELETE FROM <表>` 是 bulk 维护操作，索引无法收窄，不记 001。
 *   - `SCAN <表> USING INDEX <索引>` = 索引全扫，比全表扫描便宜仍要记（D1SCAN-003）。
 *   - `USE TEMP B-TREE` = 排序/去重溢出到临时 B-tree（D1SCAN-002，最常被忽略的性能债）。
 *     行数加权只数「非点查访问」：主键/rowid 点查（`(id=?)`）每轮最多贡献 1 行，
 *     被 join 的大表不是排序输入；全部访问都是小表或点查时不记（否则「小表驱动 +
 *     主键点查」的查询会被大表行数误记，实测 8 处噪音）。
 *   - WHERE 子句整体坍缩成单个 `?`（条件 const 带分支拼接、静态内联给不出真条件）
 *     的语句计入 skipped，不按计划结果记违规。
 *   - 源码里 SQL 常量上一行写 `// d1scan:ignore <原因>` 显式豁免整块常量（维护
 *     脚本的全量重建），豁免数进汇总输出，可 grep 可评审。
 *   - 按表行数加权：≤101 行的小表全表扫描比走索引还快，直接排除；只有大表上的
 *     才记为违规。`sqlite_*` 元数据表的扫描属于检视库结构，不计入性能债。
 *
 * 抽取五道坑（缺一就会造假阳性 / 漏检），与 d1-full-scan-audit 一致：
 *   1. 按字符串字面量边界 + 相邻 `+` 拼接重建完整 SQL，杜绝窗口截断把
 *      `SELECT ... FROM items` 后半段吃掉后判成全扫。
 *   2. 剥注释后再判断字面量之间的 `gap` 是否只含 `+`；SQL 行注释 `--` 在折叠空白
 *      之前按行剥（不剥会把注释后面的 JOIN 整段吞掉，凭空造出 no such column）。
 *   3. 字面量内的转义引号（`\'` `\"`）还原，否则 SQLite 报 unrecognized token。
 *   4. 模板串 `${...}` 替换为 `?` 占位符。
 *   5. 内联文件内字符串型 `const`（如 `citingCondition`、`TCM_CHAPTER_ORDER_SQL`），
 *      递归替换 3~4 层，否则会得到 `WHERE ?` 假阳性。
 *
 * fast-fail（AGENTS.md「行为」）：不捕获错误、不做兜底。读文件、COUNT(*)、
 * EXPLAIN、dbstat 全部直接执行，失败即在出错位置崩溃；无法静态规划的碎片由
 * {@link canPlan} 用确定性规则在前置判定中排除，并逐条列出计数，不静默吞掉。
 * 崩溃时设 `D1SCAN_TRACE=1` 可把每条待规划语句打到 stderr，直接定位出事语句。
 * 字节口径依赖 SQLite 的 dbstat 虚拟表（node 内置 SQLite 已启用；若运行环境缺失，
 * 门禁就地报错，不降级为无字节口径）。
 *
 * 只扫 `src/server` `src/pages` `src/shared` `src/layouts` `manage-cli`，
 * 排除 `src/components`（UI 注释散文含大量 `update ... from` 假命中）、
 * `src/shared/i18n`（纯翻译文案，英文整句含 from / update 之类动词）与 `tests`
 * （测试库很小，用本地大表 schema 去 EXPLAIN 会产生误导性噪音；完整审计含 tests，
 * 仍由 d1-full-scan-audit 技能负责）。
 *
 * 用 `yarn d1scan:check` 运行。默认**顾问模式**：量化报告 + 列出发现，退出码 0，
 * 不打断 `yarn check`；加 `--strict` 转为硬性失败（代码库清理后再启用）。
 * 机器可读的汇总行固定为 `D1SCAN-METRIC: key=value ...`，gate-subset 编排器解析该行，
 * 两脚本的耦合点就是这一行约定。
 */
import {existsSync, readdirSync, readFileSync, statSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {DatabaseSync} from "node:sqlite";

import {report, walk, finish, printViolations} from "./gate-utils";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const SMALL_TABLE_LIMIT = 101; // 与 d1-full-scan-audit 一致：小表全扫比索引更快
const TIMING_RUNS = 9; // 与 d1-full-scan-audit 第 3 步一致：丢弃首次预热后取中位数

// ── 1. 定位本地 D1 库 ────────────────────────────────────────────────────────
function resolveDbPath(): string {
  const fromEnv = process.env.MICROFEED_GATE_DB;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const argIdx = process.argv.findIndex((a) => a === "--db" || a === "-d");
  if (argIdx >= 0 && process.argv[argIdx + 1]) {
    const p = process.argv[argIdx + 1];
    if (existsSync(p)) return p;
  }

  const instanceIdx = process.argv.findIndex((a) => a === "--instance" || a === "-i");
  let candidates: string[] = [];
  const base = path.join(repositoryRoot, ".microfeed", "instances");
  if (instanceIdx >= 0 && process.argv[instanceIdx + 1]) {
    const inst = process.argv[instanceIdx + 1];
    candidates = collectDbFiles(path.join(base, inst));
  } else if (existsSync(base)) {
    for (const inst of readdirSync(base)) {
      candidates.push(...collectDbFiles(path.join(base, inst)));
    }
  }
  // 排除 wrangler 元数据库，挑体积最大的真实业务库
  const businessDbs = candidates
    .filter((p) => !p.endsWith("metadata.sqlite"))
    .map((p) => ({p, size: statSync(p).size}))
    .filter((x) => x.size > 0)
    .sort((a, b) => b.size - a.size);
  if (businessDbs.length === 0) {
    console.error("D1SCAN: 未找到本地 D1 业务库（.microfeed/instances/*/local-state/v3/d1/*.sqlite）。");
    console.error("D1SCAN: 请先 `yarn manage dev --local --instance <实例>` 生成本地库，或用 --db <path> 指定。");
    process.exit(2);
  }
  return businessDbs[0].p;
}

function collectDbFiles(dir: string): string[] {
  const out: string[] = [];
  const d1 = path.join(dir, "local-state", "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(d1)) return out;
  for (const f of readdirSync(d1)) {
    if (f.endsWith(".sqlite")) out.push(path.join(d1, f));
  }
  return out;
}

// ── 2. 源码 SQL 抽取 ─────────────────────────────────────────────────────────
// 门禁只覆盖「会在生产 / 运维路径真实命中数据库」的源码。排除项与理由：
//   - `src/components`：UI 注释散文含大量 `update ... from` 假命中；
//   - `src/shared/i18n`：纯翻译文案，英文整句含 from / update 之类动词；
//   - `tests`：查询跑在各自的小型测试库上，用本地大表 schema 去 EXPLAIN 会产生
//     误导性的「大表全扫」噪音（完整审计含 tests，仍由 d1-full-scan-audit 负责）。
const SCAN_DIRS = [
  "src/server",
  "src/pages",
  "src/shared",
  "src/layouts",
  "manage-cli",
].map((d) => path.join(repositoryRoot, d));
const I18N_DIR_SEGMENT = `${path.sep}i18n${path.sep}`;

function isSourceFile(name: string): boolean {
  return /\.(ts|js)$/u.test(name) && !name.endsWith(".d.ts");
}

interface SqlBlob {
  text: string;
  file: string;
  line: number;
  /** `// d1scan:ignore <原因>` 豁免理由（常量上一行），非空 = 整块常量不检查。 */
  ignore?: string;
}

/** 剥 `//` 与 `/* *\/` 注释（SQL 字面量内几乎不含 `//`，可接受极小误剥风险）。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/\/\/[^\n]*/gu, " ");
}

/** 收集文件内字符串型 `const X = "..."` / 模板串 / 拼接，供内联替换。 */
function collectConstSql(src: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /const\s+([A-Za-z_$][\w$]*)\s*=\s*([`"'])([\s\S]*?)\2/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const value = m[3].replace(/\$\{[^}]*\}/gu, " ").replace(/\s+/gu, " ").trim();
    if (/\b(SELECT|FROM|WHERE|JOIN|INSERT|UPDATE|DELETE)\b/iu.test(value)) {
      map.set(m[1], value);
    }
  }
  return map;
}

/** 把 `${NAME}` 与 `+ NAME +` 形式的 const 引用递归内联 4 层。 */
function inlineConsts(text: string, consts: Map<string, string>, depth = 0): string {
  if (depth >= 4) return text;
  let out = text;
  for (const [name, value] of consts) {
    const tmpl = new RegExp(`\\$\\{\\s*${name}\\s*\\}`, "gu");
    const concat = new RegExp(`(?:\\+\\s*)${name}(?:\\s*\\+)`, "gu");
    if (tmpl.test(out) || concat.test(out)) {
      out = out.replace(tmpl, value).replace(concat, " ");
    }
  }
  return out === text ? out : inlineConsts(out, consts, depth + 1);
}

/**
 * 把剩余的 `${...}` 模板插值替换成 `?` 占位符。SQLite 在 EXPLAIN QUERY PLAN
 * 阶段能对 `col = ?` 这类形态正确规划出索引命中（实测 `WHERE id = ?` →
 * SEARCH USING INDEX）；若替换成 `1`，`ORDER BY ${col}` 会被误写成 `ORDER BY 1`
 * （语义变成按第 1 列排序），凭空制造 TEMP B-TREE 假阳性。
 * `?` 出现在名字位置或插值子句残留处的，由 {@link canPlan} 前置排除并响亮计数。
 */
function neutralizeTemplates(text: string): string {
  return text.replace(/\$\{\s*[^}]*\s*\}/gu, "?");
}

/** 剥 SQL 行注释 `-- ...`，必须在折叠空白之前按行剥。 */
function stripSqlLineComments(sql: string): string {
  return sql.replace(/--[^\n]*/gu, " ");
}

/** `?` 之前允许出现的关键词——这些位置后面跟占位符是合法表达式。 */
const EXPR_OPENER_KEYWORDS = new Set([
  "AND", "OR", "NOT", "IN", "IS", "LIKE", "GLOB", "REGEXP", "MATCH", "BETWEEN",
  "WHEN", "THEN", "ELSE", "CASE", "WHERE", "HAVING", "SELECT", "BY", "VALUES",
  "LIMIT", "OFFSET", "DISTINCT", "ALL", "ON", "RETURNING", "EXISTS",
]);

/** 语句以子句关键词或运算符收尾 = 拼接窗口截断（如 `... ORDER BY`）。 */
const DANGLING_TAIL =
  /(?:\b(?:ORDER|GROUP|WHERE|AND|OR|SET|ON|BY|VALUES|HAVING|LIMIT|OFFSET|JOIN|FROM|IN|LIKE|IS|BETWEEN|CASE|WHEN|THEN|ELSE|NOT|SELECT|UNION|EXISTS)\s*|[,(\[=<>+\-*\/|])$/iu;

/** WHERE 子句只剩一个占位符 = 条件 const 带分支拼接，静态内联给不出真条件。 */
const WHERE_PLACEHOLDER_ONLY = /\bWHERE\s+\?\s*(?:ORDER\s+BY|GROUP\s+BY|LIMIT\b|$)/iu;

/**
 * `?` 只能出现在表达式位置：前面（仅隔空白）必须是运算符、左括号、逗号，或
 * {@link EXPR_OPENER_KEYWORDS} 里的关键词。紧跟标识符、数字、引号、右括号、
 * 另一个 `?` 的，是名字位置（表名 / 列名 / 赋值目标）或插值子句残留
 * （`... d.user_id ${where}` → `... d.user_id ?`），SQLite 语法上不成立。
 */
function hasBadPlaceholder(stmt: string): boolean {
  for (const m of stmt.matchAll(/([A-Za-z_]\w*|[\d)'"?])\s*\?/gu)) {
    const before = m[1];
    if (/^[A-Za-z_]/u.test(before) && EXPR_OPENER_KEYWORDS.has(before.toUpperCase())) continue;
    return true;
  }
  return false;
}

/**
 * 前置判定：抽取出的 SQL 片段能否交给 SQLite 静态规划。规则——
 *   ① 以 SELECT/WITH/INSERT/UPDATE/DELETE/REPLACE 开头（拦掉被窗口截断的半句）；
 *   ② WHERE 子句未整体坍缩为单个占位符（条件拼接无法静态内联，计划无意义）；
 *   ③ `?` 不出现在名字位置（FROM/JOIN/INTO/UPDATE/TABLE/INDEX/AS/SET 之后，
 *      允许被引号包住）与 `INTO <表>(` 列清单内（`VALUES(...)` 不受影响）；
 *   ④ 不是触发器体（OLD/NEW 引用无法独立规划）；
 *   ⑤ 不以子句关键词 / 运算符收尾（拼接窗口截断）；
 *   ⑥ 没有出现在名字位置或子句残留的 `?`；
 *   ⑦ 圆括号平衡。
 * 不满足的片段不计入语句数，而是逐条列出并给出原因——缺口响亮可见，不静默吞掉。
 */
function canPlan(stmt: string): boolean {
  if (!/^\s*(SELECT|WITH|INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(stmt)) return false;
  if (WHERE_PLACEHOLDER_ONLY.test(stmt)) return false;
  if (/\b(?:FROM|JOIN|INTO|UPDATE|TABLE|INDEX|AS|SET)\s*["']?\?/iu.test(stmt)) return false;
  if (/INTO\s+[A-Za-z_]\w*\s*\([^)]*\?/iu.test(stmt)) return false;
  if (/\b(?:OLD|NEW)\s*\./iu.test(stmt)) return false;
  if (DANGLING_TAIL.test(stmt)) return false;
  if (hasBadPlaceholder(stmt)) return false;
  const open = (stmt.match(/\(/gu) ?? []).length;
  const close = (stmt.match(/\)/gu) ?? []).length;
  return open === close;
}

/** {@link canPlan} 判否时的原因，用于响亮列出被排除的碎片。 */
function planSkipReason(stmt: string): string {
  if (!/^\s*(SELECT|WITH|INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(stmt)) {
    return "非查询语句开头（英文文案或拼接窗口截断）";
  }
  if (WHERE_PLACEHOLDER_ONLY.test(stmt)) {
    return "WHERE 子句整体坍缩为占位符（条件拼接无法静态内联）";
  }
  if (/\b(?:OLD|NEW)\s*\./iu.test(stmt)) return "触发器体（OLD/NEW 引用），无法独立规划";
  if (/\b(?:FROM|JOIN|INTO|UPDATE|TABLE|INDEX|AS|SET)\s*["']?\?/iu.test(stmt)) {
    return "动态名字位置（表名 / 列名 / 别名 / 赋值目标为占位符）";
  }
  if (/INTO\s+[A-Za-z_]\w*\s*\([^)]*\?/iu.test(stmt)) return "动态列清单（INTO <表>( 内为占位符）";
  if (DANGLING_TAIL.test(stmt)) return "语句不完整（以子句关键词 / 运算符收尾，拼接窗口截断）";
  if (hasBadPlaceholder(stmt)) return "占位符出现在名字位置或插值子句残留";
  return "圆括号不平衡（拼接窗口截断）";
}

/**
 * 从语句中确定性抽取候选索引列：WHERE 等值列（`col = ?`）在前，ORDER BY 列在后，
 * 去重后生成 `CREATE INDEX ... ON table(cols)`。这是候选起步形态，是否采用需人工确认。
 */
function candidateIndex(stmt: string, table: string): string {
  const eqCols = [...stmt.matchAll(/([A-Za-z_]\w*)\s*=\s*\?/gu)].map((m) => m[1]);
  const orderM = stmt.match(/ORDER BY\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)/iu);
  const orderCols = orderM ? orderM[1].split(",").map((s) => s.trim()) : [];
  const cols = [...new Set([...eqCols, ...orderCols])];
  if (cols.length === 0) return "";
  const name = `idx_${table}_${cols.join("_")}`.slice(0, 60);
  return `CREATE INDEX ${name} ON ${table} (${cols.join(", ")});`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** FROM/JOIN 之后可能紧跟子句关键词而非别名——这些词不当别名。 */
const JOIN_TAIL_KEYWORDS = new Set([
  "ON", "WHERE", "GROUP", "ORDER", "LEFT", "RIGHT", "INNER", "OUTER", "CROSS",
  "JOIN", "LIMIT", "UNION", "HAVING", "WINDOW", "USING", "SET", "VALUES",
]);

/**
 * 语句里 `FROM/JOIN <表> [AS] <别名>` 的别名→真实表名映射。计划详情里的名字是
 * 别名（`SEARCH i USING INDEX ...`），不映射回表名就永远拿不到行数。
 */
function aliasTables(stmt: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /\b(?:FROM|JOIN)\s+["'`]?([A-Za-z_]\w*)["'`]?(?:\s+(?:AS\s+)?["'`]?([A-Za-z_]\w*)["'`]?)?/giu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stmt))) {
    const table = m[1];
    const rawAlias = m[2];
    const alias = rawAlias && !JOIN_TAIL_KEYWORDS.has(rawAlias.toUpperCase()) ? rawAlias : table;
    map.set(alias.toLowerCase(), table);
    map.set(table.toLowerCase(), table);
  }
  return map;
}

/**
 * 某次表访问是否只是主键/rowid 点查（`(id=?)` / `(rowid=?)`）。点查每轮最多
 * 贡献 1 行：join 到大表不等于排序输入变大——「小表驱动 + 主键点查」的语句
 * （audit 汇总、review 列表等）其 TEMP B-TREE 只排驱动表的结果行。
 */
function isPointLookup(detail: string): boolean {
  return /\((?:id|rowid)=\?\)/u.test(detail);
}

/**
 * 数不在引号字符串内的 `?` 个数，供计时统一绑定用。真实参数值静态分析给不出，
 * 计时统一绑定整数 1——它对 LIMIT / OFFSET / rowid 比较均合法（绑定 NULL 会让
 * `LIMIT ?` 报 datatype mismatch），且走不走索引由计划决定，与具体值无关。
 */
function countPlaceholders(sql: string): number {
  let n = 0;
  let quote = "";
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) {
        if (sql[i + 1] === quote) i++; // 引号内双写引号转义
        else quote = "";
      }
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "?") n++;
  }
  return n;
}

/** 抽取并重建完整 SQL 语句（相邻字面量经 `+` 拼接）。 */
function extractSql(file: string, src: string): SqlBlob[] {
  const stripped = stripComments(src);
  const consts = collectConstSql(src);
  const litRe = /([`"'])(?:\\.|(?!\1)[^\\])*\1/g;
  const literals: {text: string; index: number}[] = [];
  let m: RegExpExecArray | null;
  while ((m = litRe.exec(stripped))) {
    // 还原字面量内的转义引号，否则 SQLite 报 unrecognized token
    literals.push({text: m[0].slice(1, -1).replace(/\\(['"\\])/gu, "$1"), index: m.index});
  }
  const blobs: SqlBlob[] = [];
  let current = "";
  let currentStart = -1;
  for (let i = 0; i < literals.length; i++) {
    const lit = literals[i];
    const prevEnd = i === 0 ? -1 : literals[i - 1].index + literals[i - 1].text.length + 2;
    const gap = stripped.slice(prevEnd + 1, lit.index).replace(/\s+/gu, "");
    const seg = lit.text;
    if (current === "") {
      current = seg;
      currentStart = lit.index;
    } else if (gap === "+") {
      current += " " + seg;
    } else {
      blobs.push(finalizeBlob(current, currentStart, file, stripped, consts, src));
      current = seg;
      currentStart = lit.index;
    }
  }
  if (current !== "") blobs.push(finalizeBlob(current, currentStart, file, stripped, consts, src));
  return blobs.filter((b) => /\b(from|join)\b/iu.test(b.text));
}

function finalizeBlob(
  text: string,
  startIdx: number,
  file: string,
  stripped: string,
  consts: Map<string, string>,
  src: string,
): SqlBlob {
  let t = inlineConsts(text, consts, 0);
  t = neutralizeTemplates(t);
  t = stripSqlLineComments(t);
  t = t.replace(/\s+/gu, " ").trim();
  const line = stripped.slice(0, Math.max(0, startIdx)).split("\n").length;
  // 常量上一行（或隔一空行再上一行）的 `// d1scan:ignore <原因>` 豁免整块常量：
  // 维护脚本的全量重建本就是整表操作，逐个语句绕不开，显式豁免比默默记违规可评审。
  // 仓库文件多为 CRLF，理由捕获到行尾空白（含 \r）为止。
  const srcLines = src.split("\n");
  let ignore: string | undefined;
  for (let back = 2; back <= 3; back += 1) {
    const marker = srcLines[line - back]?.match(/\/\/\s*d1scan:ignore\s+(.+?)\s*$/u);
    if (marker) {
      ignore = marker[1].trim();
      break;
    }
  }
  return {text: t, file: path.relative(repositoryRoot, file), line, ignore};
}

// ── 3. EXPLAIN QUERY PLAN 分类 ────────────────────────────────────────────────
interface ScanFinding {
  rule: string;
  file: string;
  line: number;
  table: string;
  message: string;
  scannedRows: number;
  scannedBytes: number;
  sql: string;
}

function main(): void {
  const dbPath = resolveDbPath();
  const db = new DatabaseSync(dbPath, {readOnly: true});
  const trace = process.env.D1SCAN_TRACE === "1";

  const tableRows = new Map<string, number>();
  /**
   * 真实表（含视图）的行数。计划详情里的名字可能是 CTE 名 / 子查询别名（如
   * `WITH a AS (...)` 计划出现 `SCAN a`），它们不在 sqlite_master 中、也无法建索引，
   * 返回 -1 表示「非真实表，不参与行数加权」。先用存在性查询做确定性前置校验，
   * 错误路径因此不可达，无需捕获。
   */
  function rowCount(table: string): number {
    const cached = tableRows.get(table);
    if (cached !== undefined) return cached;
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
      .get(table);
    if (!exists) {
      tableRows.set(table, -1);
      return -1;
    }
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as {n: number}).n;
    tableRows.set(table, n);
    return n;
  }

  const tableBytesCache = new Map<string, number>();
  /** 表或索引在本地库占用的字节数，来自 dbstat 虚拟表实测。 */
  function tableBytes(name: string): number {
    const cached = tableBytesCache.get(name);
    if (cached !== undefined) return cached;
    const row = db.prepare("SELECT SUM(pgsize) AS b FROM dbstat WHERE name = ?").get(name) as {
      b: number | null;
    };
    const bytes = row.b ?? 0;
    tableBytesCache.set(name, bytes);
    return bytes;
  }
  /** 行宽（字节/行），用于「修复后预计读取字节数」算式。 */
  function bytesPerRow(table: string): number {
    const rows = rowCount(table);
    const bytes = tableBytes(table);
    return rows > 0 ? Math.round(bytes / rows) : 0;
  }

  const files = SCAN_DIRS.flatMap((d) => walk(d, isSourceFile)).filter((f) => !f.includes(I18N_DIR_SEGMENT));
  let statementsExamined = 0;
  let bulkDeletes = 0;
  const flags: ScanFinding[] = [];
  const seenSmall: {file: string; line: number; table: string; rows: number}[] = [];
  const skipped: {file: string; line: number; reason: string; sql: string}[] = [];
  const ignored: {file: string; line: number; reason: string}[] = [];

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const blobs = extractSql(file, src);
    for (const blob of blobs) {
      if (blob.ignore) {
        ignored.push({file: blob.file, line: blob.line, reason: blob.ignore});
        continue;
      }
      const stmts = blob.text.split(";").map((s) => s.trim()).filter(Boolean);
      for (const stmt of stmts) {
        if (!/\b(from|join)\b/iu.test(stmt)) continue;
        if (!canPlan(stmt)) {
          skipped.push({file: blob.file, line: blob.line, reason: planSkipReason(stmt), sql: stmt});
          continue;
        }
        if (trace) console.error(`D1SCAN-TRACE: ${blob.file}:${blob.line} ${stmt}`);
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${stmt}`).all() as {detail: string}[];
        statementsExamined++;
        const details = plan.map((r) => r.detail);
        // 收集「无索引的全表扫描」表与「索引全扫」，供大表加权判定。
        const indexScans: {table: string; index: string}[] = [];
        let fullScanTable: string | null = null;
        for (const d of details) {
          const sm = d.match(/^SCAN\s+(\S+)(?:\s+USING INDEX\s+\S+)?/u);
          if (sm && !/USING INDEX/u.test(d)) fullScanTable = sm[1].replace(/"/gu, "");
          const im = d.match(/^SCAN\s+(\S+)\s+USING INDEX\s+(\S+)/u);
          if (im) indexScans.push({table: im[1].replace(/"/gu, ""), index: im[2].replace(/"/gu, "")});
        }
        // D1SCAN-001：大表上的真·全表扫描（行数 > 小表阈值）。
        // `sqlite_*` 是 SQLite 自带的元数据表（schema/master），扫描它属于
        // 检视库结构而非业务数据扫描，不计入性能债。无 WHERE 的整表 DELETE 是
        // bulk 维护操作（清空派生表再重建），索引无法收窄一次全删，同样不记。
        const isBulkDelete = /^\s*DELETE\b/iu.test(stmt) && !/\bWHERE\b/iu.test(stmt);
        if (fullScanTable && !fullScanTable.startsWith("sqlite_")) {
          if (isBulkDelete) {
            bulkDeletes++;
          } else {
            const rows = rowCount(fullScanTable);
            const bytes = tableBytes(fullScanTable);
            if (rows > SMALL_TABLE_LIMIT) {
              const idx = candidateIndex(stmt, fullScanTable);
              flags.push({
                rule: "D1SCAN-001",
                file: blob.file,
                line: blob.line,
                table: fullScanTable,
                message:
                  `全表扫描 ${fullScanTable}（${rows} 行 / ${bytes} 字节，超过小表阈值 ${SMALL_TABLE_LIMIT}）；` +
                  `候选索引 ${idx || "（未能从语句抽取等值列，需人工判定）"}`,
                scannedRows: rows,
                scannedBytes: bytes,
                sql: stmt,
              });
            } else if (rows >= 0) {
              seenSmall.push({file: blob.file, line: blob.line, table: fullScanTable, rows});
            }
          }
        }
        // D1SCAN-002：大表上的 TEMP B-TREE（小表排序溢出可忽略，与 d1 审计口径一致）。
        // 行数加权只数「非点查访问」：`(id=?)` 点查每轮最多 1 行，被 join 的大表
        // 不是排序输入；全部访问都是小表或点查时不记。
        if (details.some((d) => /USE TEMP B-TREE/u.test(d))) {
          const aliases = aliasTables(stmt);
          const bulkTables = new Set<string>();
          for (const d of details) {
            const am = d.match(/^(?:SCAN|SEARCH)\s+(\S+)/u);
            if (!am || isPointLookup(d)) continue;
            const name = am[1].replace(/"/gu, "");
            bulkTables.add(aliases.get(name.toLowerCase()) ?? name);
          }
          const candidates = [...bulkTables].filter((t) => !t.startsWith("sqlite_"));
          const rows = candidates.map((t) => rowCount(t));
          const anyLarge = rows.some((r) => r > SMALL_TABLE_LIMIT);
          // 全部访问都是主键/rowid 点查（无加权对象）时保守记录；访问对象全是
          // sqlite_* 元数据表（检视库结构）则不记。
          const anyUnknown = bulkTables.size === 0 || rows.some((r) => r < 0);
          if (anyLarge || anyUnknown) {
            let primary = candidates[0] ?? "?";
            for (const t of candidates) {
              if (rowCount(t) > rowCount(primary)) primary = t;
            }
            const detail = details.find((d) => /USE TEMP B-TREE/u.test(d)) ?? "";
            flags.push({
              rule: "D1SCAN-002",
              file: blob.file,
              line: blob.line,
              table: primary,
              message: `排序/去重溢出到临时 B-tree（${detail}）`,
              scannedRows: 0,
              scannedBytes: 0,
              sql: stmt,
            });
          }
        }
        // D1SCAN-003：大表上的索引全扫（d1-full-scan-audit 第 2 步：比全表扫描便宜，仍要记）。
        for (const is of indexScans) {
          if (is.table.startsWith("sqlite_")) continue;
          const rows = rowCount(is.table);
          if (rows <= SMALL_TABLE_LIMIT) continue;
          flags.push({
            rule: "D1SCAN-003",
            file: blob.file,
            line: blob.line,
            table: is.table,
            message:
              `索引全扫 ${is.table}（${rows} 行 / ${tableBytes(is.table)} 字节）走 ${is.index}` +
              `（索引 ${tableBytes(is.index)} 字节），未用索引定位行`,
            scannedRows: rows,
            scannedBytes: 0,
            sql: stmt,
          });
        }
      }
    }
  }

  // ── 4. 量化热点耗时（仅对大表全扫项，跑 9 次丢弃首次取中位数）────────────────
  // 占位符统一绑定整数 1（真实参数值未知；1 对 LIMIT/OFFSET/rowid 均合法）。
  const timed: {file: string; line: number; rule: string; ms: number}[] = [];
  for (const f of flags) {
    if (f.scannedRows <= 0 || !f.sql.trim().toLowerCase().startsWith("select")) continue;
    const params = Array<number>(countPlaceholders(f.sql)).fill(1);
    const samples: number[] = [];
    for (let i = 0; i < TIMING_RUNS; i++) {
      const t0 = performance.now();
      db.prepare(`SELECT COUNT(*) FROM (${f.sql})`).all(...params);
      samples.push(performance.now() - t0);
    }
    const warmed = samples.slice(1); // 丢弃首次预热
    warmed.sort((a, b) => a - b);
    timed.push({file: f.file, line: f.line, rule: f.rule, ms: warmed[Math.floor(warmed.length / 2)]});
  }

  // ── 5. 输出量化报告 ────────────────────────────────────────────────────────
  const scan001 = flags.filter((f) => f.rule === "D1SCAN-001");
  const scan003 = flags.filter((f) => f.rule === "D1SCAN-003");
  const tempBtree = flags.filter((f) => f.rule === "D1SCAN-002").length;
  const totalScannedRows = scan001.reduce((s, f) => s + f.scannedRows, 0);
  const totalScannedBytes = scan001.reduce((s, f) => s + f.scannedBytes, 0);

  console.log(
    `D1SCAN: 检查源文件 ${files.length} 个，抽取并 EXPLAIN 语句 ${statementsExamined} 条，` +
      `动态碎片 ${skipped.length} 条无法静态规划（已逐条列出）；` +
      `大表全表扫描 ${scan001.length} 处、索引全扫 ${scan003.length} 处、TEMP B-TREE ${tempBtree} 处；` +
      `累计将被全扫的行数 ${totalScannedRows}、字节 ${totalScannedBytes}；小表全扫 ${seenSmall.length} 处（已排除）；` +
      `整表 DELETE ${bulkDeletes} 处、d1scan:ignore 豁免 ${ignored.length} 处（均已列出）。`,
  );
  for (const s of skipped) {
    console.log(`D1SCAN: 跳过 ${s.file}:${s.line} ${s.reason} —— ${truncate(s.sql, 80)}`);
  }
  for (const g of ignored) {
    console.log(`D1SCAN: 豁免 ${g.file}:${g.line} ${g.reason}`);
  }
  for (const t of timed) {
    console.log(`D1SCAN: 热点 ${t.file}:${t.line} ${t.rule} 中位数 ${t.ms.toFixed(2)} ms`);
  }

  for (const f of flags) {
    report(f.file, f.rule, f.message, f.line);
  }

  const strict = process.argv.includes("--strict");
  if (strict && flags.length > 0) {
    finish("D1 full-table-scan");
  }
  // 默认顾问模式：量化报告 + 列出发现，但不以非零退出，避免把整条 `yarn check`
  // 打断。待代码库清理后再用 `--strict` 纳入硬性门禁。
  if (flags.length > 0) {
    printViolations();
    // AGENTS.md 最高指令要求的「修复后预计读取字节数」：算式可给，命中行数缺真实
    // 查询参数，静态分析给不出该数字——缺口与取数方法一并写明。
    for (const f of scan001) {
      console.log(
        `D1SCAN: 修复口径 ${f.file}:${f.line} —— 修复后预计读取字节数 = 命中行数 × ` +
          `${bytesPerRow(f.table)} 字节/行（${f.table} 行宽实测）+ 候选索引体积；` +
          `命中行数需真实查询参数的 A/B 实测（副本上 CREATE INDEX 前后各测一轮，` +
          `方法见 d1-full-scan-audit 第 3 步）。`,
      );
    }
  }
  const verdict = flags.length === 0 ? "OK" : `ADVISORY(${flags.length} 项待处理)`;
  console.log(
    `D1SCAN: ${verdict} —— 大表全表扫描 ${scan001.length} 处、索引全扫 ${scan003.length} 处、` +
      `TEMP B-TREE ${tempBtree} 处，累计将被全扫的行数 ${totalScannedRows}、字节 ${totalScannedBytes}。`,
  );
  console.log(
    `D1SCAN-METRIC: files=${files.length} stmts=${statementsExamined} skipped=${skipped.length} ` +
      `scan001=${scan001.length} scan003=${scan003.length} scan002=${tempBtree} ` +
      `rows=${totalScannedRows} bytes=${totalScannedBytes} small=${seenSmall.length}`,
  );
  if (flags.length > 0) {
    console.log("D1SCAN: 加 --strict 可将其转为硬性失败；候选索引与 A/B 实测方法见 microfeed-gate-subset 技能。");
  }
}

main();
