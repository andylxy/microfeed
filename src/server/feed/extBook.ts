import {readBookStats} from "@/server/feed/bookWordCount";
import {STATUSES} from "@/shared/Constants";
import {randomShortUUID} from "@/shared/StringUtils";
import type {
  BookAdmin,
  BookCategoryOption,
  BookInput,
  BooksBoard,
} from "@/shared/ExtBook";

export type {
  BookAdmin,
  BookCategoryOption,
  BookInput,
  BooksBoard,
};

/** Minimal D1-shaped database port; a fake implements it for unit tests.
 *  Same pattern as `CategoryDb` / `VolumeDb`. */
export interface BookDbRunResult {
  success: boolean;
}

export interface BookDbAllResult {
  results: Record<string, unknown>[];
}

export interface BookDbPreparedStatement {
  bind(...values: unknown[]): BookDbPreparedStatement;
  run(): Promise<BookDbRunResult>;
  all(): Promise<BookDbAllResult>;
  first(): Promise<Record<string, unknown> | null>;
}

export interface BookDb {
  prepare(query: string): BookDbPreparedStatement;
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

function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function nowIso(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

/** Read the `data._microfeed` pocket of a channel as a plain object. */
function microfeedOf(data: Record<string, unknown>): Record<string, unknown> {
  const pocket = data._microfeed;
  return pocket && typeof pocket === "object"
    ? {...(pocket as Record<string, unknown>)}
    : {};
}

function firstAuthorName(data: Record<string, unknown>): string {
  const authors = data.authors;
  if (!Array.isArray(authors)) return "";
  for (const entry of authors) {
    if (entry && typeof entry === "object") {
      const name = (entry as Record<string, unknown>).name;
      if (typeof name === "string" && name) return name;
    }
  }
  return "";
}

/**
 * Chapter count and word count per book.
 *
 * 从 `ext_book_stats`（迁移 0103）读物化结果，**不再扫 `items`**。稳态下整表读
 * 等于频道数（本地 13）行；缺失或过期的书由 `readBookStats` 当场重算一次并写回。
 * 过期由 `items` 上的触发器标记，所以写入路径不需要逐处挂钩子。
 *
 * 为什么要物化：这两个数是**跨行聚合**（该书所有条目之和），不是任何一行的字段。
 * 本地实测要产出 13 个数字必须读 9,506 行正文——后台书库页 9,523 行读，而该页
 * 是 `no-store`，没有任何缓存遮挡。加索引与改 SQL 都降不下来（`GROUP BY` 实测
 * 19,012 行，比逐本读更贵）。
 *
 * `bookIds` 收束到指定书；省略则返回表里所有书。调用方应尽量传 ids——
 * `listAdminBooks` 从 `channels` 拿到书单后回传，连「所有书」都不必再推导。
 */
async function bookStats(
  db: BookDb,
  bookIds?: string[],
): Promise<{chapters: Map<string, number>; words: Map<string, number>}> {
  const stats = await readBookStats(db, bookIds);
  const chapters = new Map<string, number>();
  const words = new Map<string, number>();
  for (const [bookId, row] of stats) {
    chapters.set(bookId, row.chaptersAll);
    words.set(bookId, row.wordsAll);
  }
  return {chapters, words};
}

async function categoryNames(db: BookDb): Promise<Map<string, string>> {
  const result = await db.prepare(
    "SELECT id, name FROM ext_category",
  ).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  return new Map(rows.map((row) => [asText(row.id), asText(row.name)]));
}

function toBookAdmin(
  row: Record<string, unknown>,
  stats: {chapters: Map<string, number>; words: Map<string, number>},
  names: Map<string, string>,
): BookAdmin {
  const data = safeParseJson(row.data);
  const microfeed = microfeedOf(data);
  const id = asText(row.id);
  const categoryId = asText(microfeed.genre).trim();
  return {
    author: firstAuthorName(data),
    categoryId,
    categoryName: names.get(categoryId) ?? "",
    chapterCount: stats.chapters.get(id) ?? 0,
    cover: asText(data.image),
    description: asText(data.description),
    id,
    isPrimary: Number(row.is_primary ?? 0) === 1,
    serialStatus: asText(microfeed.serialStatus),
    status: Number(row.status ?? 0),
    title: asText(data.title),
    // Counted from the chapters that exist, never from `_microfeed.wordCount`:
    // a hand-typed total is never recomputed, and the sample books declared
    // ~700 characters per chapter against bodies of ~50.
    wordCount: stats.words.get(id) ?? 0,
  };
}

/** Every book for the dashboard, including drafts. Deleted channels stay hidden
 *  — deletion is a soft `status = 3` so their chapters keep resolving. */
export async function listAdminBooks(db: BookDb): Promise<BookAdmin[]> {
  const result = await db.prepare(
    "SELECT id, data, status, is_primary FROM channels " +
      "WHERE status IS NULL OR status != ? ORDER BY created_at ASC",
  ).bind(STATUSES.DELETED).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  // 把书单回传，让 `bookStats` 只读这些书的物化行（本地 13 行），而不是先扫
  // `items` 推导「有哪些书」再算——那正是被迁移 0103 消掉的那笔账。
  const stats = await bookStats(db, rows.map((row) => asText(row.id)));
  const names = await categoryNames(db);
  return rows.map((row) => toBookAdmin(row, stats, names));
}

export async function getAdminBook(
  db: BookDb,
  id: string,
): Promise<BookAdmin | null> {
  const row = await db.prepare(
    "SELECT id, data, status, is_primary FROM channels WHERE id = ?",
  ).bind(id).first();
  if (!row) return null;
  // One book, one book's chapters — the old whole-corpus scan made a single
  // detail fetch cost the same as loading the whole shelf.
  const stats = await bookStats(db, [id]);
  const names = await categoryNames(db);
  return toBookAdmin(row, stats, names);
}

/** Categories a book can be filed under. */
export async function listBookCategoryOptions(
  db: BookDb,
): Promise<BookCategoryOption[]> {
  const result = await db.prepare(
    "SELECT id, name FROM ext_category WHERE visible = 1 ORDER BY sort ASC",
  ).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  return rows.map((row) => ({id: asText(row.id), name: asText(row.name)}));
}

/** The book list plus the category picker, in one round trip for the page. */
export async function loadBooksBoard(db: BookDb): Promise<BooksBoard> {
  const [books, categories] = await Promise.all([
    listAdminBooks(db),
    listBookCategoryOptions(db),
  ]);
  return {books, categories};
}

/** Build the `data` JSON for a book from dashboard input. */
function buildBookData(input: BookInput, id: string): string {
  const data: Record<string, unknown> = {
    authors: input.author ? [{name: input.author}] : [],
    title: input.title,
    ...(input.cover ? {image: input.cover} : {}),
    ...(input.description ? {description: input.description} : {}),
    _microfeed: {
      bookId: id,
      serialStatus: input.serialStatus || "serializing",
      signStatus: "signed",
      ...(input.categoryId ? {genre: input.categoryId} : {}),
    },
  };
  return JSON.stringify(data);
}

export async function createAdminBook(
  db: BookDb,
  input: BookInput,
): Promise<BookAdmin> {
  const id = randomShortUUID();
  const timestamp = nowIso();
  // `is_primary` is UNIQUE, so additional books must insert NULL — two zeroes
  // would collide.
  await db.prepare(
    "INSERT INTO channels (id, status, is_primary, data, genre, " +
      "created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?)",
  ).bind(
    id,
    input.status ?? STATUSES.PUBLISHED,
    buildBookData(input, id),
    input.categoryId ?? null,
    timestamp,
    timestamp,
  ).run();
  const created = await getAdminBook(db, id);
  if (!created) throw new Error("book create did not read back");
  return created;
}

/** Merge a partial edit into the stored `data`, keeping unknown keys intact so
 *  fields the dashboard does not show are never dropped. */
export async function updateAdminBook(
  db: BookDb,
  id: string,
  patch: Partial<BookInput>,
): Promise<BookAdmin | null> {
  const row = await db.prepare(
    "SELECT id, data, status FROM channels WHERE id = ?",
  ).bind(id).first();
  if (!row) return null;
  const data = safeParseJson(row.data);
  const microfeed = microfeedOf(data);
  const next: Record<string, unknown> = {...data};

  if (patch.title !== undefined) next.title = patch.title;
  if (patch.cover !== undefined) {
    if (patch.cover) next.image = patch.cover;
    else delete next.image;
  }
  if (patch.description !== undefined) {
    if (patch.description) next.description = patch.description;
    else delete next.description;
  }
  if (patch.author !== undefined) {
    next.authors = patch.author ? [{name: patch.author}] : [];
  }
  if (patch.serialStatus !== undefined) {
    microfeed.serialStatus = patch.serialStatus || "serializing";
  }
  if (patch.categoryId !== undefined) {
    if (patch.categoryId) microfeed.genre = patch.categoryId;
    else delete microfeed.genre;
  }
  if (microfeed.bookId == null) microfeed.bookId = id;
  next._microfeed = microfeed;

  const genre = typeof microfeed.genre === "string" ? microfeed.genre : null;
  await db.prepare(
    "UPDATE channels SET data = ?, genre = ?, updated_at = ?, " +
      "status = ? WHERE id = ?",
  ).bind(
    JSON.stringify(next),
    genre,
    nowIso(),
    patch.status ?? Number(row.status ?? STATUSES.PUBLISHED),
    id,
  ).run();
  return getAdminBook(db, id);
}

/** Soft delete: `status = 3`. The row and its chapters stay in place so a
 *  mistyped delete is recoverable, and nothing on the public site resolves a
 *  deleted channel. */
export async function deleteAdminBook(
  db: BookDb,
  id: string,
): Promise<boolean> {
  const row = await db.prepare(
    "SELECT is_primary FROM channels WHERE id = ?",
  ).bind(id).first();
  if (!row) return false;
  if (Number(row.is_primary ?? 0) === 1) return false;
  await db.prepare(
    "UPDATE channels SET status = ?, updated_at = ? WHERE id = ?",
  ).bind(STATUSES.DELETED, nowIso(), id).run();
  return true;
}
