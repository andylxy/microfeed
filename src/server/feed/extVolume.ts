import {D1_MAX_BOUND_PARAMS, STATUSES} from "@/shared/Constants";
import {TCM_CHAPTER_ORDER_SQL} from "@/server/tcm/ordering";
import type {
  VolumeBoard,
  VolumeBookOption,
  VolumeChapter,
  VolumeGroup,
} from "@/shared/ExtVolume";

export type {
  VolumeBoard,
  VolumeBookOption,
  VolumeChapter,
  VolumeGroup,
};

/** Minimal D1-shaped database port. Real D1 satisfies this structurally, and a
 *  fake implements it for unit tests — same pattern as extCategory. */
export interface VolumeDbRunResult {
  success: boolean;
}

export interface VolumeDbAllResult {
  results: Record<string, unknown>[];
}

export interface VolumeDbPreparedStatement {
  bind(...values: unknown[]): VolumeDbPreparedStatement;
  run(): Promise<VolumeDbRunResult>;
  all(): Promise<VolumeDbAllResult>;
  first(): Promise<Record<string, unknown> | null>;
}

export interface VolumeDb {
  prepare(query: string): VolumeDbPreparedStatement;
}

function safeParseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** Books (channels) offered in the volume board's book picker.
 *
 *  Unlike the public helpers this does **not** filter to published books: an
 *  admin must be able to structure a book that is still a draft. Deleted
 *  channels are the only ones hidden. TCM container channels (方剂/本草/名词,
 *  marked by `_microfeed.tcmContainer`) are not books — their entries belong to
 *  the real books through `_microfeed.sourceBookId` — so they are filtered out
 *  here instead of showing up as a book titled "方剂". */
export async function listVolumeBooks(
  db: VolumeDb,
): Promise<VolumeBookOption[]> {
  const result = await db.prepare(
    "SELECT id, data, status FROM channels ORDER BY created_at ASC",
  ).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  const books: VolumeBookOption[] = [];
  for (const row of rows) {
    if (Number(row.status) === STATUSES.DELETED) continue;
    const data = safeParseJson(row.data);
    const microfeed = data._microfeed && typeof data._microfeed === "object"
      ? data._microfeed as Record<string, unknown>
      : {};
    if (microfeed.tcmContainer != null) continue;
    books.push({
      id: asText(row.id),
      title: typeof data.title === "string" && data.title
        ? data.title
        : "未命名作品",
    });
  }
  return books;
}

/** Group one book's chapters by their `_microfeed.volume` tag.
 *
 *  Chapters are linked to a book through `_microfeed.bookId` — `items` has no
 *  `channel_id` column — so membership is resolved here in JavaScript rather
 *  than in SQL. Drafts are included so the board can organise unpublished
 *  chapters; only deleted items are skipped.
 *
 *  Volumes sort by an explicit `volumeOrder` when any chapter carries one,
 *  otherwise by their smallest `chapterNo`. The unfiled bucket always sorts
 *  last so it reads as "still to file" rather than as volume zero. */
export async function listVolumeBoard(
  db: VolumeDb,
  bookId: string,
): Promise<VolumeBoard> {
  const bookRow = await db.prepare(
    "SELECT id, data FROM channels WHERE id = ?",
  ).bind(bookId).first();
  const book: VolumeBookOption | null = bookRow == null ? null : {
    id: asText(bookRow.id),
    title: (() => {
      const data = safeParseJson(bookRow.data);
      return typeof data.title === "string" && data.title
        ? data.title
        : "未命名作品";
    })(),
  };
  if (book == null) {
    return {book, groups: [], volumeNames: []};
  }

  // TCM books (伤寒杂病论・桂林古本 等) structure chapters/sections through
  // `tcm_kind` + `tcm_parent_id` instead of `_microfeed.volume` tags, so the
  // tag-based grouping below would file every entry into the unfiled bucket.
  // Detect them by the presence of any `tcm_kind` item and use the entity
  // structure instead (chapters as volumes, sections as their chapters).
  const tcmProbe = await db.prepare(
    "SELECT 1 AS one FROM items WHERE book_id = ? AND tcm_kind IS NOT NULL AND status != ? LIMIT 1",
  ).bind(bookId, STATUSES.DELETED).first();
  if (tcmProbe != null) {
    return buildTcmVolumeBoard(db, bookId, book);
  }

  // B18: `items.book_id` is the denormalized, indexed copy of
  // `_microfeed.bookId` (migration 0056) — filtering in SQL turns the volume
  // board's full table scan into an index seek.
  const result = await db.prepare(
    "SELECT id, status, data, pub_date FROM items WHERE book_id = ? AND status != ?",
  ).bind(bookId, STATUSES.DELETED).all();
  const rows = Array.isArray(result.results) ? result.results : [];

  const chapters: VolumeChapter[] = [];
  for (const row of rows) {
    const data = safeParseJson(row.data);
    const microfeed = data._microfeed && typeof data._microfeed === "object"
      ? data._microfeed as Record<string, unknown>
      : {};
    chapters.push({
      chapterNo: asNumber(microfeed.chapterNo) ?? 0,
      id: asText(row.id),
      title: typeof data.title === "string" && data.title
        ? data.title
        : "未命名章节",
      status: Number(row.status ?? 0),
      datePublished: asText(row.pub_date),
      volume: asText(microfeed.volume).trim(),
      volumeOrder: asNumber(microfeed.volumeOrder),
    });
  }

  chapters.sort((a, b) => {
    if (a.chapterNo !== b.chapterNo) return a.chapterNo - b.chapterNo;
    if (a.datePublished !== b.datePublished) {
      return a.datePublished < b.datePublished ? -1 : 1;
    }
    return a.id < b.id ? -1 : 1;
  });

  const buckets = new Map<string, VolumeChapter[]>();
  for (const chapter of chapters) {
    const bucket = buckets.get(chapter.volume);
    if (bucket) bucket.push(chapter);
    else buckets.set(chapter.volume, [chapter]);
  }

  const groups: VolumeGroup[] = [...buckets.entries()].map(([name, list]) => {
    const explicit = list
      .map((chapter) => chapter.volumeOrder)
      .find((value): value is number => value != null);
    return {
      chapters: list,
      name,
      order: explicit ?? null,
    };
  });

  groups.sort((a, b) => {
    // The unfiled bucket (empty name) is always last.
    if (!a.name !== !b.name) return a.name ? -1 : 1;
    const aKey = a.order ?? a.chapters[0]?.chapterNo ?? 0;
    const bKey = b.order ?? b.chapters[0]?.chapterNo ?? 0;
    if (aKey !== bKey) return aKey - bKey;
    // `chapterNo` restarts in every volume (第一卷 第1章 and 第二卷 第1章 are
    // both 1), so volumes usually tie here. Fall back to the publish order of
    // each volume's first chapter — the same globally monotonic order the
    // catalog uses. Sorting the names instead would order them by pinyin
    // (第二卷 "er" before 第一卷 "yi"), which reads backward to a reader.
    const aDate = a.chapters[0]?.datePublished ?? "";
    const bDate = b.chapters[0]?.datePublished ?? "";
    if (aDate !== bDate) return aDate < bDate ? -1 : 1;
    return (a.chapters[0]?.id ?? "").localeCompare(b.chapters[0]?.id ?? "");
  });

  return {
    book,
    groups,
    volumeNames: groups
      .map((group) => group.name)
      .filter((name): name is string => name !== ""),
  };
}

/** Volume board for a TCM-structured book.
 *
 *  TCM entries carry no `_microfeed.volume` tag. Their structure is:
 *    chapter (篇章) = volume, sections (条文) = the chapters filed under it via
 *    `tcm_parent_id`. Fang (方剂) entries are not chapters: they belong to this
 *    book through `_microfeed.sourceBookId` and surface as the book's own items
 *    in the admin item list, not as a separate "方剂" volume here.
 *
 *  The board is editable, same as a novel book: the write handlers
 *  (`volume-handlers.ts`) are TCM-aware and translate each edit onto the
 *  structural fields — filing a section under a volume rewrites its
 *  `tcm_parent_id`, and renaming a volume renames the chapter entity — so the
 *  board, the item editor and the App all stay in agreement instead of the
 *  edit landing on an ignored tag.
 */
async function buildTcmVolumeBoard(
  db: VolumeDb,
  bookId: string,
  book: VolumeBookOption,
): Promise<VolumeBoard> {
  const chapterResult = await db.prepare(
    "SELECT id, status, data, pub_date FROM items " +
      "WHERE book_id = ? AND tcm_kind = 'chapter' AND status != ? " +
      // 与 App GetBookChapter / 书页目录同一排序键（netcore 字符串序，见 ordering.ts）
      "ORDER BY " + TCM_CHAPTER_ORDER_SQL,
  ).bind(bookId, STATUSES.DELETED).all();
  const chapterRows = Array.isArray(chapterResult.results)
    ? chapterResult.results
    : [];

  // 一次取回所有篇章下的条文（按 D1 单语句参数上限分片），再在内存里按所属篇章
  // 分组；此前是每个篇章各查一次，篇章一多就是 N 次往返。排序键与单篇章查询完全
  // 一致，分组后每个篇章内部的相对顺序不变。
  const chapterIds = chapterRows.map((row) => asText(row.id));
  const sectionsByParent = new Map<string, Array<Record<string, unknown>>>();
  const chunkSize = D1_MAX_BOUND_PARAMS - 1;
  for (let i = 0; i < chapterIds.length; i += chunkSize) {
    const chunk = chapterIds.slice(i, i + chunkSize);
    const sectionResult = await db.prepare(
      "SELECT id, status, data, pub_date, tcm_parent_id FROM items " +
        "WHERE tcm_parent_id IN (" + chunk.map(() => "?").join(",") + ") " +
        "AND status != ? " +
        // 条文(sections)按 receiptNo 排序；yao/term 这类没有 receiptNo 的条目
        // 退回到 `no`（与书页目录 getTcmBookEntries 的排序键一致），否则 receiptNo
        // 全为 NULL 会退化为按 id（哈希序）乱排。
        // P2: ORDER BY 以 tcm_parent_id 打头，命中 0094 的 items_section_order 索引
        // （tcm_parent_id, COALESCE(...), id）——消除 `USE TEMP B-TREE FOR ORDER BY`。
        // 调用方取回后按 tcm_parent_id 重新分组、只保留组内相对顺序，故全局序改为
        // 先按 parent 不改变任何篇章内部条文顺序（正确性不变）。
        "ORDER BY tcm_parent_id, " +
          "COALESCE(json_extract(data, '$._microfeed.receiptNo'), json_extract(data, '$._microfeed.no')), id",
    ).bind(...chunk, STATUSES.DELETED).all();
    for (const row of (Array.isArray(sectionResult.results)
      ? sectionResult.results
      : [])) {
      const parent = asText(row.tcm_parent_id);
      const list = sectionsByParent.get(parent) ?? [];
      list.push(row);
      sectionsByParent.set(parent, list);
    }
  }

  const groups: VolumeGroup[] = [];
  for (const chapterRow of chapterRows) {
    const data = safeParseJson(chapterRow.data);
    const chapterId = asText(chapterRow.id);
    const name = typeof data.title === "string" && data.title
      ? data.title
      : "未命名篇章";
    const microfeed = data._microfeed && typeof data._microfeed === "object"
      ? data._microfeed as Record<string, unknown>
      : {};

    const sectionRows = sectionsByParent.get(chapterId) ?? [];
    const chapters: VolumeChapter[] = sectionRows.map((row, index) => {
      const sectionData = safeParseJson(row.data);
      return {
        // ReceiptNo restarts per chapter, so number sections 1..N within it —
        // matching the order the App's GetChapterContent returns them.
        chapterNo: index + 1,
        id: asText(row.id),
        title: typeof sectionData.title === "string" && sectionData.title
          ? sectionData.title
          : "未命名章节",
        status: Number(row.status ?? 0),
        datePublished: asText(row.pub_date),
        volume: name,
        volumeOrder: null,
      };
    });

    groups.push({
      name,
      order: asNumber(microfeed.section) ?? 0,
      chapters,
    });
  }

  // Defense: any section in this book not filed under one of its chapters
  // (e.g. a section whose parent points elsewhere) lands in the unfiled bucket.
  // Only `section` entries are chapters-in-a-volume: fang entries belong to the
  // book as well (their book key points at the real book) but they are a
  // catalog rather than part of the chapter tree, so counting them here would
  // manufacture an "unfiled" bucket full of prescriptions.
  const orphanResult = await db.prepare(
    "SELECT id, status, data, pub_date FROM items " +
      "WHERE book_id = ? AND tcm_kind = 'section' " +
      "AND status != ? " +
      "AND (tcm_parent_id IS NULL OR tcm_parent_id NOT IN " +
      "(SELECT id FROM items WHERE book_id = ? AND tcm_kind = 'chapter'))",
  ).bind(bookId, STATUSES.DELETED, bookId).all();
  const orphanRows = Array.isArray(orphanResult.results)
    ? orphanResult.results
    : [];
  if (orphanRows.length > 0) {
    const chapters: VolumeChapter[] = orphanRows.map((row) => {
      const data = safeParseJson(row.data);
      return {
        chapterNo: 0,
        id: asText(row.id),
        title: typeof data.title === "string" && data.title
          ? data.title
          : "未命名章节",
        status: Number(row.status ?? 0),
        datePublished: asText(row.pub_date),
        volume: "",
        volumeOrder: null,
      };
    });
    groups.push({name: "", order: null, chapters});
  }

  // 方剂（tcm_kind='fang'）不在卷/章树里——它们挂在方剂容器频道下、按
  // `_microfeed.sourceBookId` 归属真实典籍，属于独立的方剂目录。管理入口已收敛
  // 到专用的 `/admin/fangs/` 看板（src/components/admin/fangs/FangsApp.tsx），
  // 此处不再内联展示，避免双入口不一致。

  return {
    book,
    groups,
    volumeNames: groups
      .map((group) => group.name)
      .filter((name): name is string => name !== ""),
    readOnly: false,
  };
}
