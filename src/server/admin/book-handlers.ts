import {z} from "zod";

import {AppError} from "@/shared/errors";
import type {
  BookAdmin,
  BookDb,
  BookInput,
  BooksBoard,
} from "@/server/feed/extBook";
import {
  createAdminBook,
  deleteAdminBook,
  loadBooksBoard,
  purgeAdminBook,
  readBookStatusCode,
  updateAdminBook,
} from "@/server/feed/extBook";
import {listFormSelectableStatusCodes} from "@/server/feed/extBookStatus";

/**
 * Dashboard-side operations for novel-cms books.
 *
 * A book is a `channels` row, so this mirrors the category handlers: validate
 * the request body, then let `extBook` (pure) do the read/write. Deletion is a
 * soft delete — the code written is the dictionary's delete state
 * (`ext_book_status.admin_list_hidden`, normally the system row 3) — and the
 * primary channel is never deletable: it is the site's own feed.
 *
 * The visible/draft choice is data since migration 0142: the allowed status
 * codes come from `ext_book_status` (`form_selectable`), so a new status shows
 * up in the editor without a deploy. Keeping a status the form no longer
 * offers is still allowed on update — only *switching* to one is refused.
 */

const titleField = z.string().trim().min(1).max(200);
const optionalText = (max: number) => z.string().max(max).optional();
const statusField = z.number().int().min(1).max(127);

const bookCreateSchema = z.object({
  author: z.string().trim().max(120).optional(),
  categoryId: z.string().trim().max(11).nullable().optional(),
  cover: z.string().trim().max(2000).optional(),
  description: optionalText(20000),
  serialStatus: z.string().trim().max(40).optional(),
  status: statusField.optional(),
  title: titleField,
});

const bookUpdateSchema = bookCreateSchema.partial();

export const BOOK_ERRORS = {
  invalidInput: "errors.books.invalidInput",
  notFound: "errors.books.notFound",
  notDeletable: "errors.books.notDeletable",
  purgeNeedsDelete: "errors.books.purgeNeedsDelete",
} as const;

function toInput(parsed: z.infer<typeof bookUpdateSchema>): Partial<BookInput> {
  const input: Partial<BookInput> = {};
  if (parsed.title !== undefined) input.title = parsed.title;
  if (parsed.author !== undefined) input.author = parsed.author;
  if (parsed.cover !== undefined) input.cover = parsed.cover;
  if (parsed.description !== undefined) input.description = parsed.description;
  if (parsed.serialStatus !== undefined) {
    input.serialStatus = parsed.serialStatus;
  }
  if (parsed.categoryId !== undefined) input.categoryId = parsed.categoryId;
  if (parsed.status !== undefined) input.status = parsed.status;
  return input;
}

export async function listBooksBoardHandler(db: BookDb): Promise<BooksBoard> {
  return loadBooksBoard(db);
}

export async function createBookHandler(
  db: BookDb,
  body: unknown,
): Promise<BookAdmin> {
  const parsed = bookCreateSchema.safeParse(body);
  if (!parsed.success) throw new AppError(BOOK_ERRORS.invalidInput, 400);
  const selectableCodes = await listFormSelectableStatusCodes(db);
  // A new book needs a status the form offers; when the caller names none, the
  // first selectable one is the default (the system "published" row normally).
  const status = parsed.data.status ?? selectableCodes[0];
  if (status === undefined || !selectableCodes.includes(status)) {
    throw new AppError(BOOK_ERRORS.invalidInput, 400);
  }
  return createAdminBook(db, {
    title: parsed.data.title,
    ...toInput({
      ...parsed.data,
      status,
      title: parsed.data.title,
    }),
  });
}

export async function updateBookHandler(
  db: BookDb,
  id: string,
  body: unknown,
): Promise<BookAdmin> {
  if (!id) throw new AppError(BOOK_ERRORS.invalidInput, 400);
  const parsed = bookUpdateSchema.safeParse(body);
  if (!parsed.success) throw new AppError(BOOK_ERRORS.invalidInput, 400);
  if (Object.keys(parsed.data).length === 0) {
    throw new AppError(BOOK_ERRORS.invalidInput, 400);
  }
  if (parsed.data.status !== undefined) {
    const current = await readBookStatusCode(db, id);
    if (current == null) throw new AppError(BOOK_ERRORS.notFound, 404);
    if (parsed.data.status !== current) {
      const selectableCodes = await listFormSelectableStatusCodes(db);
      if (!selectableCodes.includes(parsed.data.status)) {
        throw new AppError(BOOK_ERRORS.invalidInput, 400);
      }
    }
  }
  const updated = await updateAdminBook(db, id, toInput(parsed.data));
  if (!updated) throw new AppError(BOOK_ERRORS.notFound, 404);
  return updated;
}

export async function deleteBookHandler(
  db: BookDb,
  id: string,
): Promise<{deleted: true}> {
  if (!id) throw new AppError(BOOK_ERRORS.invalidInput, 400);
  const deleted = await deleteAdminBook(db, id);
  if (!deleted) throw new AppError(BOOK_ERRORS.notDeletable, 409);
  return {deleted: true};
}

/**
 * 物理删除：连章节一起清库，不可恢复。只接受已经软删除的作品（两步流程的
 * 第二段），主频道与不存在的作品同样拒绝——后者按 notFound 报，避免把
 * 「打错 id」和「删过了」混在一起。
 */
export async function purgeBookHandler(
  db: BookDb,
  id: string,
): Promise<{purged: true; chapters: number}> {
  if (!id) throw new AppError(BOOK_ERRORS.invalidInput, 400);
  const result = await purgeAdminBook(db, id);
  if (!result.purged) {
    if (result.reason === "primary") {
      throw new AppError(BOOK_ERRORS.notDeletable, 409);
    }
    if (result.reason === "notDeleted") {
      throw new AppError(BOOK_ERRORS.purgeNeedsDelete, 409);
    }
    throw new AppError(BOOK_ERRORS.notFound, 404);
  }
  return {purged: true, chapters: result.chapters};
}
