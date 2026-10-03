/**
 * Row mapping for the ctwh import (spec `.scratch/tcm-import/spec.md` §5.2
 * and §16).
 *
 * THE RELATION RULES (§16.2 — one relation, one carrier):
 *   - Channel membership → `_microfeed.bookId` (the save path mirrors it into
 *     the indexed `book_id` column): 篇章 → its 典籍 channel, 方剂 / 中药 /
 *     名词 → their container channel.
 *   - Parent-item hierarchy → the `tcm_parent_id` **column** (currently the
 *     only case: 条文 → its 篇章 item). Never written into the pocket, never
 *     used for channel membership.
 *   - Embedded detail → `fangYaoList[].yaoId` / `aliases[]`, read together
 *     with the parent, no index.
 *   - Source int64 keys are consumed here in memory (id derivation and
 *     reconciliation) and are never stored.
 *
 * The 11-char ids are DERIVED from (kind + source int64 key): re-running the
 * import reproduces the same ids and overwrites the same rows — the only
 * idempotency guarantee once no source-id column exists.
 */

import {createHash} from "node:crypto";

import type {DumpRow} from "./parse";
import {rowText, rowValue} from "./parse";

/** 源 `WorkInfo.Case` 分类码 → 当前项目分类 id（迁移 0070/0072 与既有分类）。 */
export const CATEGORY_IDS: Record<string, string> = {
  "1": "cat_zhenjiu",
  "2": "j24vLiF3Sym",
  "3": "OteD-aXHV_d",
  "5": "1runoCsI7dr",
  "9": "cat_renji01",
};

/** 迁移 0072 种下的三个容器频道（固定 id）。 */
export const CONTAINER_CHANNEL_IDS = {
  fang: "tcmfang0001",
  yao: "tcmyao00001",
  term: "tcmterm0001",
} as const;

/**
 * 源数据命名冲突正名（006 工单复验）：源 `WorkInfo.BookNo=10001` 命名为
 * 「伤寒金匮・(宋版)」，但同编号的 `Book.BookId=10001` 实际内容是「伤寒论・(宋版)」
 * 的 27 篇条文（赵开美宋版即伤寒论宋版）。源把这两个不同书复用同一编号，导入按编号
 * 关联后频道名与内容不符。金匮内容已在 `金匮要略・(宋版)` 频道，未丢。
 * 006 曾按内容正名为「伤寒论・(宋版)」让书名与卷章一致；
 * **2026-09-29 用户拍板：对齐 netcore 原样显示「伤寒金匮・(宋版)」，书名取源
 * WorkInfo.BookName，卷章关系按 BookNo 关联、不做合并特例** ⇒ 删除 override 键。
 * 该 Map 保留为空，供未来同类冲突复用。
 */
export const BOOK_NAME_OVERRIDE: Record<string, string> = {};

/**
 * 本草书（WorkInfo.BookNo）——条文的「标题 = 整段 SectionText、描述 = SectionText +
 * SectionNote」规则**只对这两本**生效。其它书（含同样有 SectionNote 的
 * 伤寒论・(人纪) / 金匮要略・(人纪)）保持「标题 = 卷内章号」，避免把整段正文塞进标题。
 */
export const HERB_BOOK_NOS: ReadonlySet<string> = new Set(["9020000", "400100"]);

const STATUS_PUBLISHED = 1;
const STATUS_UNLISTED = 4;
/** Keep in sync with `ITEM_CONTENT_TEXT_REVISION` in `src/shared/ItemSearch.ts`. */

/**
 * 容器频道（方剂 / 本草 / 名词）：工单 16 生产导入时只在远端手工创建，build 产物
 * 此前一直缺失 —— 本地重灌后 fang/yao/term 条目书键指向不存在的频道（2026-09-29
 * 本地重灌审计发现）。行数据逐字取自远端实际行（2026-09-29 抓取），保证本地与
 * 生产完全一致；INSERT OR REPLACE 幂等，重跑不翻倍。
 */
const CONTAINER_CHANNELS: Array<TargetChannel> = [
  {
    id: "tcmfang0001",
    status: STATUS_PUBLISHED,
    genre: null,
    data: { title: "方剂", description: "中医方剂库", _microfeed: { tcmContainer: "fang" } },
    createdAt: "2026-09-28 10:38:27",
  },
  {
    id: "tcmyao00001",
    status: STATUS_PUBLISHED,
    genre: null,
    data: { title: "本草", description: "中药条目库", _microfeed: { tcmContainer: "yao" } },
    createdAt: "2026-09-28 10:38:27",
  },
  {
    id: "tcmterm0001",
    status: STATUS_PUBLISHED,
    genre: null,
    data: { title: "名词", description: "中医名词解释", _microfeed: { tcmContainer: "term" } },
    createdAt: "2026-09-28 10:38:27",
  },
];

const BASE62 =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

const idOwner = new Map<string, string>();

/**
 * Deterministic 11-char item/channel id derived from (kind + source key).
 * Re-deriving the same (kind, key) in one process returns the same id —
 * buildTargets may be called repeatedly (dry-run then write) without drift.
 */
export function tcmId(kind: string, sourceKey: string | number): string {
  const owner = `${kind}:${sourceKey}`;
  for (let salt = 0; salt < 8; salt += 1) {
    const digest = createHash("sha256")
      .update(`${owner}#${salt}`)
      .digest();
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
  throw new Error(`tcmId collision exhausted salts for ${owner}`);
}

/** Source `CreateDate` (`YYYY-MM-DD HH:MM:SS`, CST) → RFC3339. */
export function toIso(mysqlDateTime: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(mysqlDateTime);
  if (!match) return null;
  return new Date(`${match[1]}T${match[2]}+08:00`).toISOString();
}

/** Plain classical text → one `<p>` per non-empty line (markers untouched). */
export function textToHtml(text: string): string {
  if (text.trim() === "") return "";
  // 无损往返（golden 对齐 2026-09-28）：行内容（含行首空格、空行）与行分隔符
  // （\r\n、\r、\n 三种源分隔符混用）都原样保留——分隔符存在 </p> 与 <p> 之间，
  // 逆变换 rawParagraphText 逐字节还原原文。空行输出 <p></p>。
  const parts = text.split(/(\r\n|\r|\n)/); // [line, sep, line, sep, …, line]
  let out = "";
  for (let i = 0; i < parts.length; i += 2) {
    out += `<p>${parts[i] ?? ""}</p>`;
    const sep = parts[i + 1];
    if (sep !== undefined) out += sep;
  }
  return out;
}

export function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 任意标记起始（ADR-03：`$u{}` `$w{}` `$f{}` `$m{}` `$n{}` `$q{}` …）。 */
const MARKER_START = /^\$[a-zA-Z]+\{/;

/** 煎服法起始：「上X味，以水…」——其后属煎服法/加减法，不再是要的组成。 */
const DOSAGE_INTRO = /上[一二三四五六七八九十百千零〇\d]+味/;
/** 段落分隔（用于无「上X味」标记时取首段）。 */
const PARAGRAPH_BREAK = /\r\n\r\n|\n\n|\r\r/;

/**
 * 读取一个标记体的内容，带**脏括号容错**。
 *
 * `openIdx` 指向标记名后的 `{`。返回内容与结束下标（正常闭合时指向 `}` 之后，
 * 脏括号时指向截断点）。源 dump 里存在 `$w{四两|` 这类未闭合写法，单纯找
 * 下一个 `}` 会把后面的其它标记一并吞掉。
 */
export function readMarkerBody(
  text: string,
  openIdx: number,
): { body: string; end: number } {
  let i = openIdx + 1;
  let depth = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      // depth 归零即本标记的闭合括号
      if (depth === 0) return { body: text.slice(openIdx + 1, i), end: i + 1 };
      depth--;
    } else if (ch === "\n" || ch === "\r") {
      break; // 未闭合：截到行尾
    } else if (ch === "$" && MARKER_START.test(text.slice(i))) {
      break; // 未闭合：下一个标记已经开始
    } else if (depth === 0 && /\s{2,}/.test(text.slice(i, i + 2))) {
      break; // 未闭合：连续空格（剂量后紧跟下一味药，如 `$w{四两|  $u{人参`)
    }
    i++;
  }
  return { body: text.slice(openIdx + 1, i), end: i };
}

/**
 * 从 `Fang.FangText` 提取药味组成 —— 供「源 `FangBody` 表缺行」时回退使用。
 *
 * 遵循 ADR-03：标记**可嵌套**且源含**脏括号**，因此**禁止**用单层正则
 * `/\$u\{([^}]*)\}/`（会漏掉嵌套式、被脏括号截断）。全库实测三种形态：
 *   分离式 `$u{药名}$w{剂量}`（788 行，绝大多数）
 *   嵌套式 `$u{药名$w{剂量}}`（5 行，外层 `}` 常缺失）
 *   脏括号  `$w{四两|  $u{人参`（15 行）
 * 策略：从 `$u{` 起线性扫描，看「先遇到 `$w{` 还是 `}`」——前者为嵌套式
 * （其前为药名），后者为分离式（到 `}` 为药名）；剂量一律走带容错的配对。
 */
export function parseFangTextIngredients(
  fangText: string,
): Array<{ showName: string; amount: string | null }> {
  // 只解析「组成段」。FangText 的结构是：组成 → 「上X味，以水…」煎服法 →
  // 加减法/注解，后两段里的 `$u{}` 不是本方的组成（如小青龙汤加减法会再提
  // 七八味药）。全段扫描会把它们虚增进来：以源 `YaoCount` 为判据实测
  // 481 首，全段命中 436、截断到煎服法前命中 451，故按语义截断。
  const intro = DOSAGE_INTRO.exec(fangText);
  const scope = intro
    ? fangText.slice(0, intro.index)
    : (fangText.split(PARAGRAPH_BREAK)[0] ?? fangText);
  const out: Array<{ showName: string; amount: string | null }> = [];
  let i = 0;
  while (i < scope.length) {
    const uIdx = scope.indexOf("$u{", i);
    if (uIdx < 0) break;
    let p = uIdx + 3;
    let nameEnd = -1; // 分离式：`$u{` 的闭合 `}`
    let doseOpen = -1; // 嵌套式：内容里 `$w{` 的 `{`
    while (p < scope.length) {
      if (scope.startsWith("$w{", p)) {
        doseOpen = p + 2;
        break;
      }
      if (scope[p] === "}") {
        nameEnd = p;
        break;
      }
      if (scope[p] === "\n" || scope[p] === "\r") break;
      if (scope[p] === "$" && MARKER_START.test(scope.slice(p))) break;
      p++;
    }
    if (nameEnd < 0 && doseOpen < 0) {
      i = uIdx + 3; // 无法判定：跳过，避免死循环
      continue;
    }
    const showName = scope.slice(uIdx + 3, nameEnd >= 0 ? nameEnd : p).trim();
    let amount: string | null = null;
    let cursor = uIdx + 3;
    if (doseOpen >= 0) {
      const read = readMarkerBody(scope, doseOpen);
      amount = read.body.trim() || null;
      cursor = read.end;
    } else if (scope.startsWith("$w{", nameEnd + 1)) {
      const read = readMarkerBody(scope, nameEnd + 3);
      amount = read.body.trim() || null;
      cursor = read.end;
    } else {
      cursor = nameEnd + 1;
    }
    if (showName) out.push({ showName, amount });
    i = cursor > uIdx + 3 ? cursor : uIdx + 3;
  }
  return out;
}

/** 标题型分隔符：SectionText 里「标题──正文」的分界（只认开头 60 字内）。 */
const TITLE_SEPARATORS = /(──|——|—|：|　)/;
const TITLE_MAX = 30;
/** 无标题分隔符时，首句短于此长度即当标题（2026-10-02：20 → 30，用户要求）。 */
const SHORT_TEXT_MAX = 30;

/** 对话/发语词：这类"标题"会大量重复（素问的「帝曰/岐伯曰」等），不当标题用。 */
const TITLE_STOPWORDS = new Set([
  "曰", "又曰", "论曰", "问曰", "师曰", "答曰", "或问", "帝曰", "岐伯曰",
  "岐伯对曰", "黄帝问曰", "黄帝曰", "雷公曰", "鬼臾区曰",
]);

/**
 * 条文标题：从 SectionText 提炼「标题──正文」式标题；提炼不出就回退章号。
 *
 * 只在 SectionText **开头 60 字内存在标题分隔符**（──/——/—/：/全角空格）时才
 * 提炼，否则说明该文是散文正文（无标题结构），强行取首个分句只会得到
 * 「论曰 / 曰 / 问曰」这类开场白或半截句子——**保留卷内章号才是正确的**。
 *
 * 提炼后还要通过校验：取第一行、折叠空白、长度 2–30、不含句末标点 `。！？`、
 * 且不是对话/发语词；`$x{}`/`$m{}` 引用标记**允许保留**（如「夫$x{药石}禀$m{…}」）。
 * 任一不满足即回退章号。
 */
export function deriveSectionTitle(
  sectionText: string,
  fallback: string,
): string {
  const text = (sectionText ?? "").trim();
  if (!text) return fallback;
  const window = text.slice(0, 60);
  const separator = TITLE_SEPARATORS.exec(window);
  let candidate: string;
  if (separator) {
    candidate = text.slice(0, separator.index);
  } else {
    // 无标题分隔符时：取**首句**（截止到第一个句末标点）当标题——
    // 例如「4、痈疽毒气攻心，发谵语」（后面才是【宜】…正文）；
    // 「今夫病，譬诸兵焉。料敌出奇者…」→ 只取「今夫病，譬诸兵焉。」。
    // 首句过长说明是整段散文，回退章号（避免拿长句当标题）。
    const firstLine = (text.split(/\r?\n/)[0] ?? "")
      .replace(/\s+/g, " ").trim();
    const firstSentence =
      (/^[^。！？]*[。！？]?/.exec(firstLine)?.[0] ?? firstLine).trim();
    candidate = firstSentence.length <= SHORT_TEXT_MAX ? firstSentence : "";
  }
  candidate = (candidate.split(/\r?\n/)[0] ?? "").replace(/\s+/g, " ").trim();
  // 去掉句末标点（「4、痈疽毒气攻心，发谵语。」→「4、痈疽毒气攻心，发谵语」）。
  candidate = candidate.replace(/[。，；、！？]+$/, "").trim();
  if (candidate.length > TITLE_MAX) {
    const cut = Math.max(
      candidate.lastIndexOf("，", TITLE_MAX),
      candidate.lastIndexOf("、", TITLE_MAX),
      candidate.lastIndexOf("：", TITLE_MAX),
      candidate.lastIndexOf("；", TITLE_MAX),
    );
    candidate = (cut > 8
      ? candidate.slice(0, cut)
      : candidate.slice(0, TITLE_MAX)).trim();
  }
  // 截断若落在引用标记 $x{…}/$m{…} 内部，把不完整的标记尾巴去掉
  // （避免标题里出现半个「$x{」）。完整标记（含配对的 }）不会被误删。
  const dangling = candidate.lastIndexOf("$");
  if (dangling >= 0 && !candidate.slice(dangling).includes("}")) {
    candidate = candidate.slice(0, dangling).trim();
  }
  const bare = candidate.replace(/^\d+\s*[、.．]\s*/, "");
  // 候选 ≤30 字允许带句中逗号/分号，如「4、痈疽毒气攻心，发谵语」——这类本身
  // 就是合适的标题；句末标点（。！？）仍一律拒绝（那说明截到了句子尾巴）。
  const allowClausePunctuation = candidate.length <= TITLE_MAX;
  const rejected =
    candidate.length < 2 ||
    bare.length < 2 || // 只剩「N、」没有实质标题
    /[。！？]/.test(candidate) ||
    (!allowClausePunctuation && /[；，]/.test(candidate)) ||
    /曰$/.test(bare) || // 帝曰 / 岐伯曰 / 故曰 / 乃问于天师曰… 一律是发语词
    TITLE_STOPWORDS.has(bare);
  return rejected ? fallback : candidate;
}

export function countMarkers(text: string): number {
  return (text.match(/\$[a-zA-Z]{1,10}\{/g) ?? []).length;
}

/**
 * 移除未配对的 UTF-16 代理字符：源库里有少量 CESU-8 残留（虻虫/雄黄/艾叶/鼠妇
 * 等条目），JSON 序列化后 Worker 编码响应体会直接 500。半个代理本身已是丢失
 * 数据，无法恢复原字；删除比替换 U+FFFD 更适合正文阅读。次数计入 report。
 */
export function stripLoneSurrogates(text: string): {text: string; removed: number} {
  let out = "";
  let removed = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text.slice(i, i + 2);
        i += 1;
      } else {
        removed += 1;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      removed += 1;
    } else {
      out += text[i];
    }
  }
  return {text: out, removed};
}

export interface TargetChannel {
  id: string;
  status: number;
  genre: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface TargetItem {
  id: string;
  status: number;
  bookId: string | null;
  tcmKind: string;
  tcmParentId: string | null;
  pubDate: string | null;
  data: Record<string, unknown>;
  contentText: string;
}

export interface ImportReport {
  channels: number;
  itemsByKind: Record<string, number>;
  /** Marker-opening count across the source text columns. */
  markerCountSource: number;
  /** Marker-opening count across the produced descriptions. */
  markerCountOutput: number;
  /** Residual MySQL escape sequences in produced text (must be 0). */
  residualEscapes: number;
  /** Unpaired surrogate code units removed (source data corruption). */
  sanitizedSurrogates: number;
  warnings: string[];
}

export interface SourceTables {
  work: DumpRow[];
  book: DumpRow[];
  bookBody: DumpRow[];
  fang: DumpRow[];
  fangBody: DumpRow[];
  yao: DumpRow[];
  yaoAlias: DumpRow[];
  mingCi: DumpRow[];
}


/**
 * 小批量取样（用户拍板）：不是"全局前 N 行"，而是**每个分组键各取前 N 行**——
 * 篇章按书取、方剂按来源书取。这样 5 部典籍的「频道→篇章→条文」链和
 * 5 个来源书的「书→方剂」关系在小批量里全部出现，不留到全量才第一次跑。
 */
function firstPerKey<T>(rows: T[], key: (row: T) => string, limit: number | null): T[] {
  if (limit == null) return rows;
  const counts = new Map<string, number>();
  const out: T[] = [];
  for (const row of rows) {
    const group = key(row);
    const taken = counts.get(group) ?? 0;
    if (taken >= limit) continue;
    counts.set(group, taken + 1);
    out.push(row);
  }
  return out;
}

export interface BuildOptions {
  /** 只导入某一本书（WorkInfo.BookNo 字符串）。其余书/方剂/中药/名词全部跳过。 */
  onlyBookNo?: string;
}

export function buildTargets(
  tables: SourceTables,
  limitPerKind: number | null,
  options: BuildOptions = {},
): {channels: TargetChannel[]; items: TargetItem[]; report: ImportReport} {
  const warnings: string[] = [];
  const channels: TargetChannel[] = [];
  const items: TargetItem[] = [];
  const onlyBookNo = options.onlyBookNo;
  const itemsByKind: Record<string, number> = {};
  let markerCountSource = 0;
  let markerCountOutput = 0;
  let residualEscapes = 0;
  let sanitizedSurrogates = 0;

  const track = (item: TargetItem, sourceText: string) => {
    items.push(item);
    itemsByKind[item.tcmKind] = (itemsByKind[item.tcmKind] ?? 0) + 1;
    const cleanDeep = (value: unknown): unknown => {
      if (typeof value === "string") {
        const result = stripLoneSurrogates(value);
        sanitizedSurrogates += result.removed;
        return result.text;
      }
      if (Array.isArray(value)) return value.map(cleanDeep);
      if (value !== null && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value)) out[key] = cleanDeep(entry);
        return out;
      }
      return value;
    };
    item.data = cleanDeep(item.data) as Record<string, unknown>;
    item.contentText = cleanDeep(item.contentText) as string;
    markerCountSource += countMarkers(sourceText);
    markerCountOutput += countMarkers(String(item.data.description ?? ""));
    // Residual MySQL escapes must not survive anywhere a reader can see them.
    for (const text of [String(item.data.description), String(item.data.title), item.contentText]) {
      if (/\\[nrt'"\\]/.test(text)) residualEscapes += 1;
    }
  };

  // ---- WorkInfo → channels ---------------------------------------------
  const bookNoToChannel = new Map<string, string>();
  const workBookNoToName = new Map<string, string>();
  const workBookNoToCase = new Map<string, string>();
  for (const row of tables.work) {
    const sourceId = String(rowValue(row, "ChapterId") ?? "");
    const bookNo = String(rowValue(row, "BookNo") ?? "");
    // 单书模式：只保留指定书（WorkInfo.BookNo），其余频道整本跳过
    if (onlyBookNo && bookNo !== onlyBookNo) continue;
    const name = rowText(row, "BookName");
    const comment = rowText(row, "Comment");
    const caseCode = rowText(row, "Case");
    const genre = CATEGORY_IDS[caseCode] ?? null;
    if (caseCode && !genre) {
      warnings.push(`未知分类码 Case=${caseCode}（书《${name}》）——genre 置空`);
    }
    const createdAt = toIso(rowText(row, "CreateDate")) ?? "2024-01-01T00:00:00.000Z";
    const id = tcmId("work", sourceId);
    workBookNoToName.set(bookNo, name.trim());
    workBookNoToCase.set(bookNo, caseCode);
    channels.push({
      id,
      status: STATUS_PUBLISHED,
      genre,
      data: {
        title: (BOOK_NAME_OVERRIDE[bookNo] ?? name).trim(),
        description: comment,
        _microfeed: {
          author: rowText(row, "Author"),
          chengShu: rowText(row, "ChenɡShu"),
          chapterCount: rowValue(row, "Chapter"),
          hot: rowValue(row, "HotBook"),
          comment,
          sourceImagePath: rowText(row, "ImageUrl"),
          // 源 WorkInfo.Case 原值：App 端按 caseTag 区分行为（1/2/3 隐方药页、5=伤寒显单位页）。
          case: caseCode,
          // 源书号（WorkInfo.BookNo）：书的三级关系按 BookNo 匹配，显式落库便于校验与回溯。
          bookNo,
        },
      },
      createdAt,
    });
    bookNoToChannel.set(bookNo, id);
  }

  // 频道 → 书号 反向映射：本草书的条文规则按书判定（见 HERB_BOOK_NOS）。
  const channelToBookNo = new Map<string, string>();
  for (const [bookNo, id] of bookNoToChannel) channelToBookNo.set(id, bookNo);

  // 容器频道（方剂/本草/名词）随产物一起发出，保证 fang/yao/term 条目书键有归属
  // 容器频道：全量模式发出方剂/本草/名词三个；单书模式只带方剂容器（本书方剂的归属）
  if (onlyBookNo) {
    channels.push(...CONTAINER_CHANNELS.filter((c) => c.id === "tcmfang0001"));
  } else {
    channels.push(...CONTAINER_CHANNELS);
  }

  // ---- Book → chapter items --------------------------------------------
  const selectedBooks = firstPerKey(
    tables.book,
    (row) => String(rowValue(row, "BookId") ?? ""),
    limitPerKind,
  );
  const selectedBookSourceIds = new Set(
    selectedBooks.map((row) => String(rowValue(row, "BookInfoId") ?? "")),
  );

  const sectionRowsByChapter = new Map<string, DumpRow[]>();
  for (const row of tables.bookBody) {
    const chapterSourceId = String(rowValue(row, "BookInfoId") ?? "");
    if (limitPerKind != null && !selectedBookSourceIds.has(chapterSourceId)) {
      continue;
    }
    const group = sectionRowsByChapter.get(chapterSourceId) ?? [];
    group.push(row);
    sectionRowsByChapter.set(chapterSourceId, group);
  }

  const chapterIdBySource = new Map<string, string>();
  const chapterChannelBySource = new Map<string, string>();
  const chapterHeaderBySource = new Map<string, string>();
  const bookNosWithChapters = new Set<string>();
  // netcore GetBookChapter 按源主键（BookInfoId）序返回 —— 这是唯一能同时解释
  // 两类反例的排序：9040000 的「前言」（section=904000203）排第 3（数值序会垫底），
  // 10001 的 section 0..21 按数字序（字符串序会排成 0,1,10,11,…）。落
  // `_microfeed.no` = 书内主键排名，作篇章排序键（reads/extCategory/extVolume
  // 三处 ORDER BY 共用，见 src/server/tcm/ordering.ts；同 fangRankByFangId 先例）。
  const chapterRankBySource = new Map<string, number>();
  {
    const byBook = new Map<string, DumpRow[]>();
    for (const row of tables.book) {
      const bookNo = String(rowValue(row, "BookId") ?? "");
      if (onlyBookNo && bookNo !== onlyBookNo) continue;
      const group = byBook.get(bookNo) ?? [];
      group.push(row);
      byBook.set(bookNo, group);
    }
    for (const rows of byBook.values()) {
      const ordered = [...rows].sort((a, b) => {
        const av = Number(rowValue(a, "BookInfoId") ?? 0);
        const bv = Number(rowValue(b, "BookInfoId") ?? 0);
        return av - bv;
      });
      ordered.forEach((row, index) => {
        chapterRankBySource.set(String(rowValue(row, "BookInfoId") ?? ""), index + 1);
      });
    }
  }
  for (const row of selectedBooks) {
    const sourceId = String(rowValue(row, "BookInfoId") ?? "");
    const bookNo = String(rowValue(row, "BookId") ?? "");
    // 单书模式：其他书的篇章静默跳过（频道表里本就没有它们，不告警）
    if (onlyBookNo && bookNo !== onlyBookNo) continue;
    const channelId = bookNoToChannel.get(bookNo);
    if (!channelId) {
      warnings.push(`篇章 ${sourceId} 的书编号 ${bookNo} 无对应频道，整章跳过`);
      continue;
    }
    bookNosWithChapters.add(bookNo);
    const header = rowText(row, "ChapterHeader");
    const sectionRows = (sectionRowsByChapter.get(sourceId) ?? [])
      .slice(0, limitPerKind == null ? undefined : 5)
      .sort(
        (a, b) =>
          Number(rowValue(a, "ReceiptNo") ?? 0) -
          Number(rowValue(b, "ReceiptNo") ?? 0),
      );
    const description = sectionRows
      .map((sectionRow) => textToHtml(rowText(sectionRow, "SectionText")))
      .filter((html) => html.length > 0)
      .join("");
    const pubDate = toIso(rowText(row, "CreateDate"));
    const item: TargetItem = {
      id: tcmId("chapter", sourceId),
      status: STATUS_PUBLISHED,
      bookId: channelId,
      tcmKind: "chapter",
      tcmParentId: null,
      pubDate,
      data: {
        // 篇章标题原样保留（不 trim）：netcore GetBookChapter.chapterHeader 原样下发
        // （400100 8 处前导空格、9040000 3 处尾随空格，golden 逐字节对齐 2026-10-01）。
        // 同 MingCi title「原样不 trim」惯例（§4.11）。
        title: header,
        description,
        content_format: "html",
        _microfeed: {
          bookId: channelId,
          section: rowValue(row, "ChapterSection"),
          // 书内主键排名：篇章排序键（netcore 按源主键序下发，见上方注释）
          no: chapterRankBySource.get(sourceId) ?? null,
        },
      },
      contentText: htmlToPlain(description),
    };
    chapterIdBySource.set(sourceId, item.id);
    chapterChannelBySource.set(sourceId, channelId);
    chapterHeaderBySource.set(sourceId, header);
    track(item, sectionRows.map((r) => rowText(r, "SectionText")).join("\n"));
  }

  // ---- BookBody → section items ----------------------------------------
  for (const [chapterSourceId, rows] of sectionRowsByChapter) {
    const parentId = chapterIdBySource.get(chapterSourceId);
    const channelId = chapterChannelBySource.get(chapterSourceId);
    if (!parentId || !channelId) continue;
    const capped = limitPerKind == null ? rows : rows.slice(0, 5);
    // 条文标题规范为「卷内章号」（与《伤寒杂病论・(桂林古本)》既有的 "1/2/3" 模式一致）：
    // 源脏标题「第<ReceiptNo>条・<篇章名>」只在卷面板 / 阅读页产生噪声。源 ReceiptNo 仍保留在
    // `_microfeed.receiptNo`（未丢失），排序按 ReceiptNo（与 backfill 的 chapterNo、卷面板 ORDER BY 一致）。
    const ordered = capped.slice().sort(
      (a, b) =>
        Number(rowValue(a, "ReceiptNo") ?? 0) -
        Number(rowValue(b, "ReceiptNo") ?? 0),
    );
    ordered.forEach((row, idx) => {
      const receiptNo = rowValue(row, "ReceiptNo");
      const sectionText = rowText(row, "SectionText");
      const sectionNote = rowText(row, "SectionNote");
      // 本草书条文（9020000 神农本草经・(人纪) / 400100 神农本草经疏 且源
      // SectionNote 非空）：标题取整段 SectionText（保留源序号），描述 =
      // SectionText + SectionNote（源解说并入正文）。
      // 其余条文（含伤寒论・(人纪) 等同样带 note 的书）保持「标题=卷内章号」，
      // 否则整段正文会被塞进标题。
      const isHerbEntry =
        HERB_BOOK_NOS.has(channelToBookNo.get(channelId) ?? "") &&
        sectionNote.trim() !== "";
      const description = isHerbEntry
        ? textToHtml(sectionText) + textToHtml(sectionNote)
        : textToHtml(sectionText);
      const pubDate = toIso(rowText(row, "CreateDate"));
      track(
        {
          id: tcmId("section", String(rowValue(row, "BookBodyId") ?? "")),
          status: STATUS_UNLISTED,
          bookId: channelId,
          tcmKind: "section",
          tcmParentId: parentId,
          pubDate,
          data: {
            // 本草条目保留整段 SectionText（含源序号）；其余条文从 SectionText
            // 提炼标题，提炼不出才回退「卷内章号」。
            title: (isHerbEntry
              ? sectionText
              : deriveSectionTitle(sectionText, String(idx + 1))).trim(),
            description,
            content_format: "html",
            _microfeed: {
              bookId: channelId,
              receiptNo,
              note: sectionNote,
              videoMemo: rowText(row, "SectionVideoMemo"),
              fangList: rowText(row, "FangJi")
                .split(",")
                .map((name) => name.trim())
                .filter((name) => name.length > 0),
              // 源 BookBody.BieMing：别名接口第三源（result[0]=正名，其余为别名）。
              bieMing: rowText(row, "BieMing"),
            },
          },
          contentText: htmlToPlain(description),
        },
        // track 的第二参数是「源正文」——本草条目描述已并入 SectionNote，
        // 源侧必须同步带上 note，否则 build 末尾「标记数 源 vs 产物」断言会失败。
        isHerbEntry ? sectionText + sectionNote : sectionText,
      );
    });
  }

  // ---- FangBody grouped, Fang → formula items ---------------------------
  const fangBodyByFang = new Map<string, DumpRow[]>();
  for (const row of tables.fangBody) {
    const fangId = String(rowValue(row, "FangId") ?? "");
    const group = fangBodyByFang.get(fangId) ?? [];
    group.push(row);
    fangBodyByFang.set(fangId, group);
  }
  const selectedFangs = firstPerKey(
    tables.fang,
    (row) => String(rowValue(row, "FangSourceBookId") ?? ""),
    limitPerKind,
  ).filter((row) => {
    // 单书模式：只要本书来源的方剂（FangSourceBookId = 指定 BookNo）
    if (!onlyBookNo) return true;
    return String(rowValue(row, "FangSourceBookId") ?? "") === onlyBookNo;
  });
  // 单书模式：netcore GetBookIdFang 按源主键（FangId 数值）升序返回，FangNo 序与
  // 其不一致的书（如 1001000）用「源主键排名」作 no 对齐（no 仅排序键，不下发）
  const fangRankByFangId = new Map<string, number>();
  if (onlyBookNo) {
    const ordered = [...selectedFangs].sort((a, b) => {
      const av = BigInt(String(rowValue(a, "FangId") ?? "0"));
      const bv = BigInt(String(rowValue(b, "FangId") ?? "0"));
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
    ordered.forEach((row, index) => {
      fangRankByFangId.set(String(rowValue(row, "FangId") ?? ""), index + 1);
    });
  }
  // 源 dump 里实际存在的 `Yao.YaoId` 集合 —— FangBody 0-based YaoID 补偿后的
  // 成员闸：YaoId 不连续（dump 只截取了部分行），仅判 `<= yaoMaxId` 会放行
  // 指向集合外空洞 id 的引用，产出悬空 yaoId（金匮要略・(宋版) 实测 2 处，
  // 2026-10-01）。成员检查让这类行像越界行一样落 null。
  const yaoSourceIdSet = new Set(
    tables.yao.map((row) => String(rowValue(row, "YaoId") ?? "")),
  );

  // ---- FangText 组成回退 ------------------------------------------------
  /**
   * 源 dump 的 `FangBody` 表并不完整：金匮要略・(人纪) 49 首方剂只有 2 首有
   * FangBody 行、桂林古本 329 首只有 7 首 —— 其余方剂的药味组成其实写在
   * `Fang.FangText` 的 `$u{药名}$w{剂量}` 标记里（`YaoCount` 与标记数吻合）。
   * 只认 FangBody 会让这些方剂的 `fangYaoList` 为空，后台「药味组成」与 App
   * `standardYaoList` 都拿不到数据（2026-10-03 修复）。
   *
   * 白名单说明：宋版（10001/10002）在 netcore 侧共 315 首方剂，其中 3 首
   * （禹余粮丸 / 杏子汤 / 黄连粉）正文明确标注「(佚)」「方未见。」、`YaoCount=0`
   * 且无 `$u{}` 标记 —— 源本身无数据，回退对它们天然不生效。白名单保留是为了
   * 让「哪些书启用了回退」显式可查，避免全量静默开启。用户已拍板：
   * 数据完整性优先于 golden 逐字对齐，故桂林古本（1001000）一并纳入。
   */
  const FANG_TEXT_FALLBACK_BOOK_NOS = new Set(["9040000", "9050000", "1001000"]);

  /** 药名（正名 + `YaoList` 别名）→ 源 `Yao.YaoId`。 */
  const yaoIdByName = new Map<string, string>();
  for (const row of tables.yao) {
    const yaoId = String(rowValue(row, "YaoId") ?? "");
    if (!yaoId) continue;
    const names = [rowText(row, "YaoName"), ...rowText(row, "YaoList").split(/[,，]/)];
    for (const raw of names) {
      const name = raw.trim();
      if (name && !yaoIdByName.has(name)) yaoIdByName.set(name, yaoId);
    }
  }
  /**
   * 异名 / 古名 / 异体字 → 源 `Yao.YaoName` 正名。回退解析
   * （parseFangTextIngredients）从 `Fang.FangText` 的 `$u{}` 标记抽出的药名，
   * 常是古名 / 异写 / 带后缀（芎藭 / 葶苈 / 干地黄 / 川乌 …），与 `Yao.YaoName`
   * 不完全一致，导致 `yaoId` 算不出落点（编辑页药味组成显示空白 / 下拉错名）。
   * 这些映射全部经本地库 172 味 yao 条目 + 源 `Yao.sql`（172 味）双向核验，
   * 目标正名在源内确实存在，可安全桥接（2026-10-03 防复发固化，
   * 对应 `.scratch/tcm-import/repair_fang_yao_null.mjs` 实测救回的 63 条）。
   *
   * ⚠️ 源 dump `Yao.sql` 仅 172 味（netcore 实有 601），以下药名在源内与本地
   * 都无独立条目，属已知数据缺口，保持 `yaoId=null` 不强行造假：
   * 狼毒 / 冬瓜子 / 香蒲 / 木通 / 王瓜根 / 鸡子（经方或指黄或指白，歧义）/
   * 食蜜（≠石蜜）/ （庶/虫）虫（乱码名）。
   */
  const YAO_NAME_ALIASES: Record<string, string> = {
    "芎藭": "芎䓖", "芎穷": "芎䓖", "川芎": "芎䓖",
    "诃黎勒": "诃梨勒",
    "白蔹": "白敛",
    "葶苈": "葶苈子", "葶历": "葶苈子",
    "括蒌": "栝蒌", "括蒌实": "栝蒌", "栝楼实": "栝蒌",
    "牡丹": "牡丹皮",
    "干地黄": "地黄", "生地黄": "地黄", "地黄汁": "地黄", "熟地黄": "地黄",
    "大附子": "附子",
    "白酒": "酒",
    "葱白": "葱",
    "麻仁": "麻子仁", "麻子": "麻子仁",
    "神曲": "曲", "神麯": "曲",
    "豆黄": "豆黄卷",
    "薏苡": "薏苡仁", "苡米": "薏苡仁",
    "木防已": "防己", "木防己": "防己",
    "川乌": "乌头",
    "山药": "薯蓣",
    "桑根白皮": "桑东南根白皮",
    "蒴藿": "蒴藋细叶", "蒴藋": "蒴藋细叶",
    "太乙禹余粮": "禹余粮",
    "防已": "防己",
    "乌扇": "射干",
    "芜花": "芫花",
  };

  /**
   * 药名归一化：去序号前缀（「1、」）→ 去空白 → 去尾部括号修饰
   * （「牡蛎 (熬)」→「牡蛎」）→ 异名桥接 → 去尾部「剂量+单位」
   * （回退解析偶把剂量吞进药名，如「人参三两」「甘草二两 (炙)」）。
   * 单位必须出现才剥离，避免误伤以数字结尾的真药名（如「三七」）。
   */
  function normalizeYaoShowName(s: string): string {
    let x = String(s ?? "")
      .replace(/^\d+\s*[、.．.]\s*/, "")
      .replace(/\s+/g, "")
      .replace(/[（(][^）)]*[）)]\s*$/, "");
    const alias = YAO_NAME_ALIASES[x];
    if (alias) x = alias;
    x = x.replace(
      /[一二三四五六七八九十百千0-9]+\s*(两|斤|个|枚|升|合|钱|分|铢|撮|把|握|束|片|枝|根|茎|叶|花|仁|斗|丸|贴)\s*$/,
      "",
    );
    return x.trim();
  }

  /**
   * 按名查药：经 `normalizeYaoShowName` 归一后查 `yaoIdByName`。
   * ⚠️ 这里**不做** FangBody 那套 0-based `+1` 补偿 —— `+1` 只针对
   * `FangBody.YaoID` 的错位引用，按名解析直接命中真实 `YaoId`。
   */
  function lookupYaoIdByName(showName: string): string | null {
    const key = normalizeYaoShowName(showName);
    if (!key) return null;
    return yaoIdByName.get(key) ?? null;
  }

  type FangYaoEntry = {
    yaoId: string | null;
    amount: string | null;
    weight: string | number | null;
    suffix: string | null;
    showName: string;
    extraProcess: string | null;
  };
  // 单书模式：本书方剂组成引用的中药条目（fangYaoList.yaoId 的关系依赖）一并导入
  const onlyBookYaoIds = new Set<string>();
  if (onlyBookNo) {
    for (const row of selectedFangs) {
      const fid = String(rowValue(row, "FangId") ?? "");
      for (const bodyRow of fangBodyByFang.get(fid) ?? []) {
        // ⚠️ `FangBody.YaoID` 是 **0-based 引用**（见下方 fangYaoList 的 +1
        // 补偿），而 onlyBookYaoIds 是按 `Yao.YaoId`（真实 id）查的 —— 必须
        // 同样 +1 并做成员检查，否则单书导入会漏掉真正被引用的中药、却导入
        // 「序号少一位」的错药，使 fangYaoList.yaoId 悬空（2026-10-03 修复；
        // 此前只能靠 repour 后跑 import-yao.mjs 收尾来掩盖）。
        const raw = rowValue(bodyRow, "YaoID");
        const key = raw === null ? Number.NaN : Number(raw) + 1;
        if (Number.isFinite(key) && yaoSourceIdSet.has(String(key))) {
          onlyBookYaoIds.add(String(key));
        }
      }
    }
  }
  for (const row of selectedFangs) {
    const fangId = String(rowValue(row, "FangId") ?? "");
    const sourceBookNo = String(rowValue(row, "FangSourceBookId") ?? "");
    const sourceChannelId = bookNoToChannel.get(sourceBookNo) ?? null;
    if (sourceBookNo && !sourceChannelId) {
      if (!onlyBookNo) {
        warnings.push(`方剂 ${fangId} 的来源书 ${sourceBookNo} 无对应频道`);
      }
    }
    let fangYaoList: FangYaoEntry[] = (fangBodyByFang.get(fangId) ?? []).map((bodyRow) => {
      const yaoSourceId = rowValue(bodyRow, "YaoID");
      // ⚠️ 源 `FangBody.YaoID` 是 **0-based 引用**：比 `Yao.YaoId` 整体少 1
      // （实测 2023 行全量验证：YaoID+1 精确命中 1927 行；其余 94 行是 ShowName
      // 用别名——白芍药/香豉/白蜜/栝楼实 —— 与 Yao 表正名异写同药，语义一致；
      // 仅 2 行 YaoID=172 越界）。甘草的源引用是 0（悬空）。
      // 不补偿会让每条方剂组成的 `yaoId` 指向「序号少一位」的错误中药条目
      // （编辑页药名下拉显示错名、甘草显示空白）——2026-09-30 实测修复。
      const yaoSourceKey = Number(yaoSourceId) + 1;
      const yaoRefKey =
        yaoSourceId &&
        Number.isFinite(yaoSourceKey) &&
        yaoSourceIdSet.has(String(yaoSourceKey))
          ? String(yaoSourceKey)
          : null;
      return {
        yaoId: yaoRefKey ? tcmId("yao", yaoRefKey) : null,
        amount: rowText(bodyRow, "Amount"),
        weight: rowValue(bodyRow, "Weight"),
        suffix: rowText(bodyRow, "Suffix"),
        showName: rowText(bodyRow, "ShowName"),
        extraProcess: rowText(bodyRow, "ExtraProcess"),
      };
    });
    // FangBody 缺失 → 从正文 `$u{}/$w{}` 标记回退（仅白名单书号启用）。
    // 回退新增的引用必须同步进 onlyBookYaoIds，否则单书 repour 时这些中药
    // 条目不在导入集里，yaoId 会悬空。
    let fromFangText = false;
    if (fangYaoList.length === 0 && FANG_TEXT_FALLBACK_BOOK_NOS.has(sourceBookNo)) {
      fangYaoList = parseFangTextIngredients(rowText(row, "FangText")).map((entry) => {
        const yaoSourceKey = lookupYaoIdByName(entry.showName);
        if (onlyBookNo && yaoSourceKey) onlyBookYaoIds.add(yaoSourceKey);
        return {
          yaoId: yaoSourceKey ? tcmId("yao", yaoSourceKey) : null,
          amount: entry.amount,
          weight: null,
          suffix: null,
          showName: entry.showName,
          extraProcess: null,
        };
      });
      fromFangText = fangYaoList.length > 0;
    }
    const description = textToHtml(rowText(row, "FangText"));
    const pubDate = toIso(rowText(row, "CreateDate"));
    track(
      {
        id: tcmId("fang", fangId),
        status: STATUS_PUBLISHED,
        bookId: CONTAINER_CHANNEL_IDS.fang,
        tcmKind: "fang",
        tcmParentId: null,
        pubDate,
        data: {
          title: rowText(row, "FangName").trim(),
          description,
          content_format: "html",
          _microfeed: {
            bookId: CONTAINER_CHANNEL_IDS.fang,
            sourceBookId: sourceChannelId,
            // 排序键：全量 = 源 FangNo；单书 = 源主键排名（netcore 按主键序返回）
            no: onlyBookNo
              ? fangRankByFangId.get(fangId) ?? null
              : rowValue(row, "FangNo"),
            yaoCount: rowValue(row, "YaoCount"),
            drinkNum: rowValue(row, "FangdrinkNum"),
            // 回退生效时源 `YaoList` 为空，改用解析出的药名（保序去重）
            yaoList: fromFangText
              ? [...new Set(fangYaoList.map((entry) => entry.showName).filter(Boolean))]
              : rowText(row, "YaoList")
                  .split(",")
                  .map((name) => name.trim())
                  .filter((name) => name.length > 0),
            fangList: rowText(row, "FangList")
              .split(",")
              .map((name) => name.trim())
              .filter((name) => name.length > 0),
            fangYaoList,
          },
        },
        contentText: htmlToPlain(description),
      },
      rowText(row, "FangText"),
    );
  }

  // ---- yaoAlias folded, Yao → herb items --------------------------------
  // 旧后端 GetAliaZhongYao 把 yaoAlias 表**原样**下发（`name` = yaoAlias.YaoName），
  // 不与 Yao 表 join。故 4 条 `YaoName` 用短名（蜜/艾/煅灶灰；Yao 表用 石蜜/艾叶/煅灶下灰）
  // 也必须原样发出（golden 实测：{食蜜→蜜}、{艾叶→艾}、{煅灶下灰→煅灶灰}；{白蜜→蜜} 会被
  // 第二源 Yao.YaoList 覆盖为 {白蜜→石蜜}）。这些"孤儿"别名挂到**最贴近**的 yao 条目上——
  // endpoint（reads.ts getAppYaoAliases）只遍历全部 yao 的 aliases[] 并 add(bieming, name)，
  // 挂在哪条不影响输出，但 `name` 必须保持源 yaoAlias.YaoName 原样才能逐字节对齐 netcore。
  const yaoNameSet = new Set(tables.yao.map((row) => rowText(row, "YaoName")));
  const yaoListTokens = new Map(
    tables.yao.map((row) => [
      rowText(row, "YaoName"),
      rowText(row, "YaoList").split(/[,，]/).map((s) => s.trim()).filter((s) => s.length > 0),
    ]),
  );
  const resolveYaoCarrier = (canonical: string): string | null => {
    if (yaoNameSet.has(canonical)) return canonical;
    for (const [name, tokens] of yaoListTokens) if (tokens.includes(canonical)) return name;
    for (const name of yaoNameSet) if (name.includes(canonical)) return name;
    let best: string | null = null;
    let bestLen = 0;
    for (const name of yaoNameSet) {
      let i = 0;
      while (i < canonical.length && i < name.length && canonical[i] === name[i]) i += 1;
      if (i > bestLen) { bestLen = i; best = name; }
    }
    return bestLen > 0 ? best : null;
  };
  const aliasesByYaoName = new Map<string, Array<{bieming: string; name: string}>>();
  for (const row of tables.yaoAlias) {
    const canonical = rowText(row, "YaoName");
    const alias = rowText(row, "YaoBieMing");
    if (!canonical || !alias) continue;
    const carrier = resolveYaoCarrier(canonical);
    if (!carrier) continue;
    const list = aliasesByYaoName.get(carrier) ?? [];
    // name 用源 yaoAlias.YaoName 原样（对齐 netcore），不是 Yao 表的正名。
    list.push({bieming: alias, name: canonical});
    aliasesByYaoName.set(carrier, list);
  }
  const selectedYao =
    onlyBookNo
      ? tables.yao.filter((row) =>
          onlyBookYaoIds.has(String(rowValue(row, "YaoId") ?? "")),
        )
      : limitPerKind == null
        ? tables.yao
        : tables.yao.slice(0, limitPerKind);
  for (const row of selectedYao) {
    const name = rowText(row, "YaoName");
    const description = textToHtml(rowText(row, "YaoText"));
    const pubDate = toIso(rowText(row, "CreateDate"));
    track(
      {
        id: tcmId("yao", String(rowValue(row, "YaoId") ?? "")),
        status: STATUS_PUBLISHED,
        bookId: CONTAINER_CHANNEL_IDS.yao,
        tcmKind: "yao",
        tcmParentId: null,
        pubDate,
        data: {
          title: name.trim(),
          description,
          content_format: "html",
          _microfeed: {
            bookId: CONTAINER_CHANNEL_IDS.yao,
            bieMing: rowText(row, "YaoBieMing"),
            // 源 YaoNo：App 端可见的排序键（同 receiptNo 先例）
            no: rowValue(row, "YaoNo"),
            // 源 Yao.YaoList（药名列表）：别名接口第二源，每 token → YaoName。
            yaoNames: rowText(row, "YaoList"),
            aliases: aliasesByYaoName.get(name) ?? [],
          },
        },
        contentText: htmlToPlain(description),
      },
      rowText(row, "YaoText"),
    );
  }

  // ---- MingCi → term items ----------------------------------------------
  const selectedTerms =
    onlyBookNo
      ? []
      : limitPerKind == null
        ? tables.mingCi
        : tables.mingCi.slice(0, limitPerKind);
  for (const row of selectedTerms) {
    const description = textToHtml(rowText(row, "MingCiText"));
    const pubDate = toIso(rowText(row, "CreateDate"));
    track(
      {
        id: tcmId("term", String(rowValue(row, "MingCiId") ?? "")),
        status: STATUS_PUBLISHED,
        bookId: CONTAINER_CHANNEL_IDS.term,
        tcmKind: "term",
        tcmParentId: null,
        pubDate,
        data: {
          // 旧后端对 MingCiName 原样下发（含尾部换行，如 "畏\n"），不 trim——golden 逐字节对齐
          title: rowText(row, "MingCiName"),
          description,
          content_format: "html",
          _microfeed: {
            bookId: CONTAINER_CHANNEL_IDS.term,
            beiMing: rowText(row, "MingCiBeiMing"),
            type: rowText(row, "MingCiType"),
            // 源 MingCiNo：App 端可见的排序键（同 receiptNo 先例）
            no: rowValue(row, "MingCiNo"),
            // 源 MingCi.MingCiList：旧后端按英文逗号劈成数组下发（mingCiList）。
            mingCiList: rowText(row, "MingCiList"),
            sourceImagePath: rowText(row, "ShowImage"),
          },
        },
        contentText: htmlToPlain(description),
      },
      rowText(row, "MingCiText"),
    );
  }

  // 源缺口告警：WorkInfo 里有书（且非小说 caseTag=0），但 Book 表没有任何篇章行
  // → 该频道导入后 0 章。caseTag=0 的小说本无卷属正常，不告警。
  for (const [bookNo, name] of workBookNoToName) {
    const caseCode = workBookNoToCase.get(bookNo) ?? "";
    if (caseCode === "0" || caseCode === "") continue;
    if (!bookNosWithChapters.has(bookNo)) {
      warnings.push(
        `源缺口：书《${name}》(BookNo=${bookNo}, Case=${caseCode}) 在源 Book 表无篇章行，导入后频道 0 章`,
      );
    }
  }

  if (markerCountSource !== markerCountOutput) {
    warnings.push(
      `标记数不一致：源 ${markerCountSource} / 产物 ${markerCountOutput}（转译丢改了正文）`,
    );
  }

  return {
    channels,
    items,
    report: {
      channels: channels.length,
      itemsByKind,
      markerCountSource,
      markerCountOutput,
      residualEscapes,
      sanitizedSurrogates,
      warnings,
    },
  };
}
