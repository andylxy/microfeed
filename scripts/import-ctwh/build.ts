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
        title: header.trim(),
        description,
        content_format: "html",
        _microfeed: {
          bookId: channelId,
          section: rowValue(row, "ChapterSection"),
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
    const header = chapterHeaderBySource.get(chapterSourceId) ?? "";
    for (const row of capped) {
      const receiptNo = rowValue(row, "ReceiptNo");
      const description = textToHtml(rowText(row, "SectionText"));
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
            title: `第${String(receiptNo ?? "?")}条・${header}`,
            description,
            content_format: "html",
            _microfeed: {
              bookId: channelId,
              receiptNo,
              note: rowText(row, "SectionNote"),
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
        rowText(row, "SectionText"),
      );
    }
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
  // 单书模式：本书方剂组成引用的中药条目（fangYaoList.yaoId 的关系依赖）一并导入
  const onlyBookYaoIds = new Set<string>();
  if (onlyBookNo) {
    for (const row of selectedFangs) {
      const fid = String(rowValue(row, "FangId") ?? "");
      for (const bodyRow of fangBodyByFang.get(fid) ?? []) {
        const y = String(rowValue(bodyRow, "YaoID") ?? "");
        if (y) onlyBookYaoIds.add(y);
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
    const fangYaoList = (fangBodyByFang.get(fangId) ?? []).map((bodyRow) => {
      const yaoSourceId = rowValue(bodyRow, "YaoID");
      return {
        yaoId: yaoSourceId ? tcmId("yao", String(yaoSourceId)) : null,
        amount: rowText(bodyRow, "Amount"),
        weight: rowValue(bodyRow, "Weight"),
        suffix: rowText(bodyRow, "Suffix"),
        showName: rowText(bodyRow, "ShowName"),
        extraProcess: rowText(bodyRow, "ExtraProcess"),
      };
    });
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
            yaoList: rowText(row, "YaoList")
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
  const aliasesByYaoName = new Map<string, Array<{bieming: string; name: string}>>();
  for (const row of tables.yaoAlias) {
    const canonical = rowText(row, "YaoName");
    const alias = rowText(row, "YaoBieMing");
    if (!canonical || !alias) continue;
    const list = aliasesByYaoName.get(canonical) ?? [];
    list.push({bieming: alias, name: canonical});
    aliasesByYaoName.set(canonical, list);
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
