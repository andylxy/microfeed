import {STATUSES} from "@/shared/Constants";
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
 *  channels are the only ones hidden. */
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

  const result = await db.prepare(
    "SELECT id, status, data, pub_date FROM items WHERE status != ?",
  ).bind(STATUSES.DELETED).all();
  const rows = Array.isArray(result.results) ? result.results : [];

  const chapters: VolumeChapter[] = [];
  for (const row of rows) {
    const data = safeParseJson(row.data);
    const microfeed = data._microfeed && typeof data._microfeed === "object"
      ? data._microfeed as Record<string, unknown>
      : {};
    if (asText(microfeed.bookId) !== bookId) continue;
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
