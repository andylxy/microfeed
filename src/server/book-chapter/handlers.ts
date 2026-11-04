/**
 * 独立「书本卷章」模块（ADR-0062）的 handler 层。
 *
 * 与 `ming-ci/handlers.ts` 同构：Zod 校验请求体，然后交给 `store.ts`（纯读写）。
 * 无公共 api/v1——模块只给后台用（ADR-0062 决策 9，不进 OpenAPI、不在 exempt 名单）。
 *
 * 严格校验只有一条硬约束：`chapterHeader` / `sectionText` 非空。文本字段
 * **一律不 trim**（ADR-0062 决策 6）——源正文的前导缩进、句号后空格、换行
 * 都是内容，校验只做长度与非空判定，绝不改写值。
 */

import {AppError} from "@/shared/errors";
import {randomShortUUID} from "@/shared/StringUtils";
import type {BookChapterDb} from "./types";
import type {
  BookChapterAdmin,
  BookChapterBoard,
  BookChapterBodyAdmin,
  BookChapterSourceBook,
} from "@/shared/BookChapter";
// 建表/编辑 schema 的唯一真源在 `@/shared/BookChapter`（UI 与 server 共用），
// 这里只 import，不再本地重写——字段约束改一处即两侧生效。
import {
  bookChapterBodyCreateSchema,
  bookChapterBodyUpdateSchema,
  bookChapterCreateSchema,
  bookChapterUpdateSchema,
} from "@/shared/BookChapter";
// 分类清单只读复用 book-info 的 SSOT 入口（settings.book_groups），不重写解析。
import {loadBookGroups} from "@/server/book-info/groups";
import {
  createBookChapter,
  createBookChapterBody,
  getBookChapter,
  getBookChapterBody,
  listBodiesByChapter,
  loadBookChapterBoard,
  purgeBookChapter,
  purgeBookChapterBody,
  softDeleteBookChapter,
  softDeleteBookChapterBody,
  updateBookChapter,
  updateBookChapterBody,
} from "./store";

export const BOOK_CHAPTER_ERRORS = {
  invalidInput: "errors.bookChapter.invalidInput",
  notFound: "errors.bookChapter.notFound",
  purgeNeedsDelete: "errors.bookChapter.purgeNeedsDelete",
  purgeHasBodies: "errors.bookChapter.purgeHasBodies",
} as const;

/** 来源书下拉（从 `book_info` 加载，供 `sourceBookId` 选择；只给未软删的书）。
 *  来源引用是宽松校验（可空/悬空回落），此处只做加载。`case_division` 是
 *  `book_info` 既有列（ADR-0059 的分组归属键），左栏三层树靠它把书归到分类。 */
async function loadBookChapterSourceBooks(
  db: D1Database,
): Promise<BookChapterSourceBook[]> {
  const result = await db.prepare(
    "SELECT id, book_name, book_no, case_division FROM book_info " +
      "WHERE deleted_at IS NULL ORDER BY book_name ASC, id ASC",
  ).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  return rows.map((row) => ({
    id: String(row.id ?? ""),
    bookName: String(row.book_name ?? ""),
    bookNo: String(row.book_no ?? ""),
    caseDivision: String(row.case_division ?? ""),
  }));
}

/** 看板一次取齐：分类清单（`settings.book_groups`）+ 来源书（`book_info`）
 *  + 卷章目录（`book_chapter`）。三者都是只读派生，链路
 *  `book_chapter.source_book_id → book_info.id → case_division → 分组 key`
 *  供左栏拼「分类 → 书名 → 卷」三层导航。
 *  正文不在看板里（8066 行太重），选中卷章后走 bodies 端点取。 */
export async function listBookChapterBoardHandler(
  db: BookChapterDb,
  sourceDb: D1Database,
): Promise<BookChapterBoard> {
  const [groups, sourceBooks, chapters] = await Promise.all([
    loadBookGroups(sourceDb),
    loadBookChapterSourceBooks(sourceDb),
    loadBookChapterBoard(db),
  ]);
  return {groups, sourceBooks, chapters};
}

export async function createBookChapterHandler(
  db: BookChapterDb,
  body: unknown,
): Promise<BookChapterAdmin> {
  const parsed = bookChapterCreateSchema.safeParse(body);
  if (!parsed.success) throw new AppError(BOOK_CHAPTER_ERRORS.invalidInput, 400);
  // id 在这里生成（store 保持纯读写）。
  const id = randomShortUUID();
  return createBookChapter(db, id, parsed.data);
}

export async function updateBookChapterHandler(
  db: BookChapterDb,
  id: string,
  body: unknown,
): Promise<BookChapterAdmin> {
  if (!id) throw new AppError(BOOK_CHAPTER_ERRORS.invalidInput, 400);
  const parsed = bookChapterUpdateSchema.safeParse(body);
  if (!parsed.success) throw new AppError(BOOK_CHAPTER_ERRORS.invalidInput, 400);
  if (Object.keys(parsed.data).length === 0) {
    throw new AppError(BOOK_CHAPTER_ERRORS.invalidInput, 400);
  }
  const updated = await updateBookChapter(db, id, parsed.data);
  if (!updated) throw new AppError(BOOK_CHAPTER_ERRORS.notFound, 404);
  return updated;
}

export async function getBookChapterHandler(
  db: BookChapterDb,
  id: string,
): Promise<BookChapterAdmin> {
  if (!id) throw new AppError(BOOK_CHAPTER_ERRORS.invalidInput, 400);
  const chapter = await getBookChapter(db, id);
  if (!chapter) throw new AppError(BOOK_CHAPTER_ERRORS.notFound, 404);
  return chapter;
}

export async function deleteBookChapterHandler(
  db: BookChapterDb,
  id: string,
): Promise<{deleted: true}> {
  if (!id) throw new AppError(BOOK_CHAPTER_ERRORS.invalidInput, 400);
  const deleted = await softDeleteBookChapter(db, id);
  if (!deleted) throw new AppError(BOOK_CHAPTER_ERRORS.notFound, 404);
  return {deleted: true};
}

export async function purgeBookChapterHandler(
  db: BookChapterDb,
  id: string,
): Promise<{purged: true}> {
  if (!id) throw new AppError(BOOK_CHAPTER_ERRORS.invalidInput, 400);
  const result = await purgeBookChapter(db, id);
  if (!result.purged) {
    if (result.reason === "notDeleted") {
      throw new AppError(BOOK_CHAPTER_ERRORS.purgeNeedsDelete, 409);
    }
    if (result.reason === "hasBodies") {
      throw new AppError(BOOK_CHAPTER_ERRORS.purgeHasBodies, 409);
    }
    throw new AppError(BOOK_CHAPTER_ERRORS.notFound, 404);
  }
  return {purged: true};
}

/** 某卷章下的正文列表（含已软删，`isDeleted` 区分）。 */
export async function listBookChapterBodiesHandler(
  db: BookChapterDb,
  chapterId: string,
): Promise<{bodies: BookChapterBodyAdmin[]}> {
  if (!chapterId) throw new AppError(BOOK_CHAPTER_ERRORS.invalidInput, 400);
  return {bodies: await listBodiesByChapter(db, chapterId)};
}

export async function createBookChapterBodyHandler(
  db: BookChapterDb,
  chapterId: string,
  body: unknown,
): Promise<BookChapterBodyAdmin> {
  if (!chapterId) throw new AppError(BOOK_CHAPTER_ERRORS.invalidInput, 400);
  const parsed = bookChapterBodyCreateSchema.safeParse(body);
  if (!parsed.success) throw new AppError(BOOK_CHAPTER_ERRORS.invalidInput, 400);
  const id = randomShortUUID();
  return createBookChapterBody(db, id, chapterId, parsed.data);
}

export async function updateBookChapterBodyHandler(
  db: BookChapterDb,
  bodyId: string,
  body: unknown,
): Promise<BookChapterBodyAdmin> {
  if (!bodyId) throw new AppError(BOOK_CHAPTER_ERRORS.invalidInput, 400);
  const parsed = bookChapterBodyUpdateSchema.safeParse(body);
  if (!parsed.success) throw new AppError(BOOK_CHAPTER_ERRORS.invalidInput, 400);
  if (Object.keys(parsed.data).length === 0) {
    throw new AppError(BOOK_CHAPTER_ERRORS.invalidInput, 400);
  }
  const updated = await updateBookChapterBody(db, bodyId, parsed.data);
  if (!updated) throw new AppError(BOOK_CHAPTER_ERRORS.notFound, 404);
  return updated;
}

export async function getBookChapterBodyHandler(
  db: BookChapterDb,
  bodyId: string,
): Promise<BookChapterBodyAdmin> {
  if (!bodyId) throw new AppError(BOOK_CHAPTER_ERRORS.invalidInput, 400);
  const body = await getBookChapterBody(db, bodyId);
  if (!body) throw new AppError(BOOK_CHAPTER_ERRORS.notFound, 404);
  return body;
}

export async function deleteBookChapterBodyHandler(
  db: BookChapterDb,
  bodyId: string,
): Promise<{deleted: true}> {
  if (!bodyId) throw new AppError(BOOK_CHAPTER_ERRORS.invalidInput, 400);
  const deleted = await softDeleteBookChapterBody(db, bodyId);
  if (!deleted) throw new AppError(BOOK_CHAPTER_ERRORS.notFound, 404);
  return {deleted: true};
}

export async function purgeBookChapterBodyHandler(
  db: BookChapterDb,
  bodyId: string,
): Promise<{purged: true}> {
  if (!bodyId) throw new AppError(BOOK_CHAPTER_ERRORS.invalidInput, 400);
  const result = await purgeBookChapterBody(db, bodyId);
  if (!result.purged) {
    if (result.reason === "notDeleted") {
      throw new AppError(BOOK_CHAPTER_ERRORS.purgeNeedsDelete, 409);
    }
    throw new AppError(BOOK_CHAPTER_ERRORS.notFound, 404);
  }
  return {purged: true};
}
