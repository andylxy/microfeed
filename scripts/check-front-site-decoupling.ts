/**
 * 前台内容引擎零耦合门禁（ADR-0066 决策 1 / 12 / 15，规范 §8「解耦断言」、§9 第 20 步）。
 *
 * 手动触发：node --import tsx scripts/check-front-site-decoupling.ts
 * 不并入 `yarn check`，也不并入 `microfeed-gate-subset`：AGENTS.md 的最高指令是
 * 「门禁只在用户手动触发时跑」，本脚本只是把规范里那条不变式写成可执行断言，
 * 由调用者决定何时跑。
 *
 * 扫描范围是规范 §8 逐字列出的那一份，不是「整个 src/」：
 *   - src/server/catalog/**（七个只读模块）
 *   - 四条前台页面（首页 / 分类 / 书 / 卷）
 *   - 三条新条目路由（中药 / 方剂 / 名词）
 *   - src/server/tcm/markerPopover.ts
 *   - src/pages/sitemap.xml.ts
 *
 * 四处已知例外显式登记在 KNOWN_EXCEPTIONS：前两处是规范 §6 保留的运行时旧链路
 * （中间件每请求 loadFeed、robots.txt 经 publicSiteFileResponse），后两处是后台 /
 * 站点文件模块，本次不重构。登记它们是为了让「不扫」成为有据可查的决定，也防止
 * 后来有人把例外路径写进扫描清单。页面取数路径零读，不等于全仓零读。
 *
 * 注释与 `front-decoupling:ignore-start/end` 区段不参与判定：前者只是说明文字，
 * 后者是后台反向引用视图专用的旧索引写入口（前台 buildTcmMarkerLayer 不调用）。
 * 替换注释时保留换行，行号才不会漂移。
 */
import {existsSync, readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {finish, report, walk} from "./gate-utils";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

const SCAN_DIRS = [
  path.join(repositoryRoot, "src", "server", "catalog"),
];

const SCAN_FILES = [
  "src/pages/index.astro",
  "src/pages/category/[slug]/index.astro",
  "src/pages/book/[id]/index.astro",
  "src/pages/book/[id]/v/[volumeId]/index.astro",
  "src/pages/zhongyao/[id]/index.astro",
  "src/pages/fang-yao/[id]/index.astro",
  "src/pages/ming-ci/[id]/index.astro",
  "src/server/tcm/markerPopover.ts",
  "src/pages/sitemap.xml.ts",
];

/** 规范 §6 / §8：这四处保留旧链路，不在零耦合不变式的作用域里。 */
const KNOWN_EXCEPTIONS = new Set([
  "src/middleware.ts",
  "src/pages/robots.txt.ts",
  "src/server/site-files/public.ts",
  "src/server/feed/siteNav.ts",
]);

/** D1 裁决 A：旧出口一律退场，不写 301、不建映射表、不加 legacy_item_id。 */
const RETIRED_ROUTES = [
  "src/pages/i/[slug]/index.astro",
  "src/pages/i/[slug]/rss/index.ts",
  "src/pages/i/[slug]/json/index.ts",
  "src/pages/rss/index.ts",
  "src/pages/rss/stylesheet.ts",
  "src/pages/json/index.ts",
  "src/pages/llms.txt.ts",
  "src/pages/api/llms.txt.ts",
  "src/pages/api/llms-full.txt.ts",
  "src/pages/[...path].astro",
];

/** 词边界排除连字符与标识符字符：CSS 的 `align-items` 不是旧表名。 */
const word = (value: string): RegExp =>
  new RegExp(`(?<![A-Za-z0-9_-])${value}(?![A-Za-z0-9_-])`, "u");

/** 规范 §8 解耦断言 ① ② + §2.1 的 is_enable 口径断言。 */
const BANNED: Array<{label: string; pattern: RegExp}> = [
  ...[
    "items",
    "channels",
    "ext_category",
    "ext_book_stats",
    "ext_book_status",
    "legacy_item_id",
    "ext_marker_citations",
    "ensureMarkerCitations",
    "loadPublishedFeed",
    "loadFeed",
    "getPublicJsonData",
    "publicFeed",
    "themeContext",
    "renderThemeTemplate",
    "is_enable",
  ].map((label) => ({label, pattern: word(label)})),
  {label: "new Theme", pattern: /\bnew\s+Theme\b/u},
];

/** 只认重定向语义里的 301；尺寸、数值字面量不参与判定。 */
const REDIRECT_301 =
  /(?:\bredirect\b|\bstatus\b)[^\n]{0,80}\b301\b|\b301\b[^\n]{0,80}(?:\bredirect\b|\bstatus\b)/iu;

/** 内容表：查询这些表时可见性只认 deleted_at IS NULL（规范 §2.1）。 */
const CONTENT_TABLES =
  "book_info|book_chapter_body|book_chapter|fang_yao_body|fang_yao|zhong_yao|ming_ci";
const FROM_CONTENT_TABLE = new RegExp(`\\bFROM\\s+(?:c\\.|b\\.)?(${CONTENT_TABLES})\\b`, "iu");

/** 表名由模板变量拼出时无法静态判定，要求改成显式 SQL。 */
const DYNAMIC_FROM = /\bFROM\s+\$\{/u;

const IGNORE_START = "front-decoupling:ignore-start";
const IGNORE_END = "front-decoupling:ignore-end";

interface ScanTarget {
  relative: string;
  absolute: string;
}

function collectTargets(): ScanTarget[] {
  const targets: ScanTarget[] = [];
  for (const directory of SCAN_DIRS) {
    for (const absolute of walk(directory, (name) => /\.(?:ts|astro)$/u.test(name))) {
      targets.push({
        relative: path.relative(repositoryRoot, absolute).replace(/\\/gu, "/"),
        absolute,
      });
    }
  }
  for (const relative of SCAN_FILES) {
    targets.push({
      relative,
      absolute: path.join(repositoryRoot, relative),
    });
  }
  return targets.filter((target) => {
    if (KNOWN_EXCEPTIONS.has(target.relative)) {
      report(
        target.relative,
        "DECOUPLE-001",
        "已知例外被列入扫描范围；按规范 §8 重新裁定后再决定是否加入",
      );
      return false;
    }
    return existsSync(target.absolute);
  });
}

/** 注释内容替换成空格，保留换行与长度；`://` 不当行注释。 */
function stripComments(code: string): string {
  return code
    .replace(/<!--[\s\S]*?-->/gu, (match) => match.replace(/[^\n]/gu, " "))
    .replace(/\/\*[\s\S]*?\*\//gu, (match) => match.replace(/[^\n]/gu, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gu, (match, prefix: string) =>
      prefix + " ".repeat(match.length - prefix.length),
    );
}

/**
 * 先按原始源码剔除后台专用区段，再剥注释。顺序不能反：区段标记本身是行注释，
 * 先剥注释会把 `front-decoupling:ignore-start` 擦掉，整段旧索引写入就会被误判。
 * 两步都保留换行，行号不漂移。
 */
function scannableLines(code: string): string[] {
  let skip = false;
  const kept = code.split("\n").map((line) => {
    if (line.includes(IGNORE_START)) {
      skip = true;
      return "";
    }
    if (line.includes(IGNORE_END)) {
      skip = false;
      return "";
    }
    return skip ? "" : line;
  });
  return stripComments(kept.join("\n")).split("\n");
}

function checkBanned(target: ScanTarget, lines: string[]): void {
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    for (const banned of BANNED) {
      if (banned.pattern.test(line)) {
        report(
          target.relative,
          "DECOUPLE-001",
          `零耦合不变式：前台取数链不得出现 "${banned.label}"`,
          index + 1,
        );
      }
    }
    // D1 裁决 A：旧地址失效，不写 301、不回查旧条目页。
    if (REDIRECT_301.test(line) || /["'`]\/i\//u.test(line)) {
      report(
        target.relative,
        "DECOUPLE-004",
        "旧地址一律 404；不得写 301 重定向或 /i/ 链接",
        index + 1,
      );
    }
  }
}

/**
 * 规范 §2.1：内容表的查询只认 deleted_at IS NULL。SQL 常跨行字符串拼接，
 * 所以在命中 FROM 的那一行前后各看 4 行（一个拼接块），窗口内必须有该条件。
 */
function checkVisibility(target: ScanTarget, lines: string[]): void {
  if (!target.relative.startsWith("src/server/catalog/")) return;
  for (const [index, line] of lines.entries()) {
    if (DYNAMIC_FROM.test(line)) {
      report(
        target.relative,
        "DECOUPLE-002",
        "表名由模板变量拼出，可见性条件无法静态判定；改成显式 SQL",
        index + 1,
      );
      continue;
    }
    const match = FROM_CONTENT_TABLE.exec(line);
    if (!match) continue;
    const window = lines.slice(Math.max(0, index - 4), index + 5).join("\n");
    if (!/deleted_at\s+IS\s+NULL/iu.test(window)) {
      report(
        target.relative,
        "DECOUPLE-002",
        `查询 ${match[1]} 必须只用 deleted_at IS NULL 判可见性`,
        index + 1,
      );
    }
  }
}

/**
 * D5-A：按书解析方剂的两处 SQL 必须带书作用域。判定落在函数体里、且先剥注释，
 * 避免「注释里出现字面量就通过」或「按 id 点查的语句被误判」。
 */
function functionBody(lines: string[], name: string): string | null {
  const start = lines.findIndex((line) => line.includes(`function ${name}`));
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    // 只认行首的顶层声明；函数体内的 `const x = ...` 不截断函数体。
    if (/^(?:export\s|function\s)/u.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function checkFangScope(): void {
  const scopedFunctions: Array<{relative: string; name: string}> = [
    {relative: "src/server/catalog/refs.ts", name: "loadFangRefsForBook"},
    {relative: "src/server/catalog/entries.ts", name: "listFangByBook"},
  ];
  for (const {relative, name} of scopedFunctions) {
    const absolute = path.join(repositoryRoot, relative);
    if (!existsSync(absolute)) {
      report(relative, "DECOUPLE-003", `方剂按书解析入口 ${name} 缺失`);
      continue;
    }
    const body = functionBody(
      scannableLines(readFileSync(absolute, "utf8")),
      name,
    );
    if (!body || !body.includes("source_book_legacy_id = ?")) {
      report(
        relative,
        "DECOUPLE-003",
        `${name} 必须带 source_book_legacy_id = ?；禁止按名全表匹配`,
      );
    }
  }

  // DECOUPLE-006 同时守住「路由文件齐备」与「引用 URL 指向新路由」两面。
  const refs = "src/server/catalog/refs.ts";
  if (existsSync(path.join(repositoryRoot, refs))) {
    const source = scannableLines(
      readFileSync(path.join(repositoryRoot, refs), "utf8"),
    ).join("\n");
    for (const prefix of ["/fang-yao/", "/zhongyao/"]) {
      if (!source.includes(prefix)) {
        report(refs, "DECOUPLE-006", `标注层引用必须指向新条目路由 ${prefix}`);
      }
    }
  }
}

/** D1 裁决 A：旧出口文件存在即视为兼容层回滚。 */
function checkRetiredRoutes(): void {
  for (const relative of RETIRED_ROUTES) {
    if (existsSync(path.join(repositoryRoot, relative))) {
      report(relative, "DECOUPLE-005", "旧前台出口未删除；旧地址必须一律 404");
    }
  }
}

/** 三条新条目路由必须齐备，缺一条就会有内容无法访问。 */
function checkEntryRoutes(): void {
  for (const relative of [
    "src/pages/zhongyao/[id]/index.astro",
    "src/pages/fang-yao/[id]/index.astro",
    "src/pages/ming-ci/[id]/index.astro",
  ]) {
    if (!existsSync(path.join(repositoryRoot, relative))) {
      report(relative, "DECOUPLE-006", "新条目路由缺失");
    }
  }
}

const targets = collectTargets();
for (const target of targets) {
  const lines = scannableLines(readFileSync(target.absolute, "utf8"));
  checkBanned(target, lines);
  checkVisibility(target, lines);
}
checkFangScope();
checkRetiredRoutes();
checkEntryRoutes();

finish("front-site decoupling");

console.log(
  `OK: ${targets.length} 个前台取数/渲染文件通过零耦合不变式；` +
    `${KNOWN_EXCEPTIONS.size} 处已知例外按规范 §6 保留，${RETIRED_ROUTES.length} 个旧出口已退场。`,
);
