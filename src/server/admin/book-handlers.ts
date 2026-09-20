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
  updateAdminBook,
} from "@/server/feed/extBook";

/**
 * Dashboard-side operations for novel-cms books.
 *
 * A book is a `channels` row, so this mirrors the category handlers: validate
 * the request body, then let `extBook` (pure) do the read/write. Deletion is a
 * soft `status = 3` and the primary channel is never deletable — it is the
 * site's own feed.
 */

const titleField = z.string().trim().min(1).max(200);
const optionalText = (max: number) => z.string().max(max).optional();

const bookCreateSchema = z.object({
  author: z.string().trim().max(120).optional(),
  categoryId: z.string().trim().max(11).nullable().optional(),
  cover: z.string().trim().max(2000).optional(),
  description: optionalText(20000),
  serialStatus: z.string().trim().max(40).optional(),
  status: z.union([z.literal(1), z.literal(2)]).optional(),
  title: titleField,
});

const bookUpdateSchema = bookCreateSchema.partial();

export const BOOK_ERRORS = {
  invalidInput: "errors.books.invalidInput",
  notFound: "errors.books.notFound",
  notDeletable: "errors.books.notDeletable",
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
  return createAdminBook(db, {
    title: parsed.data.title,
    ...toInput({
      ...parsed.data,
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
