import {z} from "zod";

import {AppError} from "@/shared/errors";
import {BOOK_STATUS_COLOR_PATTERN} from "@/shared/ExtBook";
import type {BookStatusDb, BookStatusRow} from "@/server/feed/extBookStatus";
import {
  countChannelsByStatus,
  createBookStatus,
  deleteBookStatus,
  listBookStatusRows,
  updateBookStatus,
} from "@/server/feed/extBookStatus";

/**
 * Dashboard-side operations for the book status dictionary (migration 0142).
 *
 * Same shape as `book-handlers.ts`: validate the request body with zod, then
 * let `extBookStatus` (pure) do the read/write. The code of a new status is
 * assigned by the server (smallest free custom code), so the dashboard never
 * picks one and can never collide with a system row.
 */

const nameField = z.string().trim().min(1).max(40);
/** `#RGB` / `#RRGGBB` — the only shapes the native colour input produces;
 *  `null` clears the colour. */
const colorField = z.string().trim().regex(BOOK_STATUS_COLOR_PATTERN).nullable();

const bookStatusCreateSchema = z.object({
  nameZh: nameField,
  nameEn: nameField,
  formSelectable: z.boolean().optional(),
  publicVisible: z.boolean().optional(),
  adminListHidden: z.boolean().optional(),
  sort: z.number().int().min(0).max(9999).optional(),
  colorFg: colorField.optional(),
  colorBg: colorField.optional(),
});

const bookStatusUpdateSchema = bookStatusCreateSchema.partial();

/**
 * 删除态（`admin_list_hidden`）的转移规则：全表只有一个，只能「由另一行认领」
 * 来转移，不能直接取消——取消后软删除写哪一行都无从判断，已删除的书也会同时
 * 从主列表和「已删除」里消失。
 *
 * 转移前还要确认旧持有行上没有书：那些书的状态码会从「删除态」变成普通状态，
 * 等于把它们瞬间放回在展示的位置。返回 `"required"`（想取消）、旧持有行上的
 * 书数（想转移但行上还有书）、或 null（可以走）。
 */
async function deleteStateConflict(
  db: BookStatusDb,
  code: number | null,
  wanted: boolean,
): Promise<"required" | number | null> {
  if (!wanted) return "required";
  const rows = await listBookStatusRows(db);
  const holder = rows.find((row) => row.adminListHidden);
  if (!holder || holder.code === code) return null;
  const counts = await countChannelsByStatus(db);
  const inUse = counts.get(holder.code) ?? 0;
  return inUse > 0 ? inUse : null;
}

export const BOOK_STATUS_ERRORS = {
  invalidInput: "errors.bookStatuses.invalidInput",
  notFound: "errors.bookStatuses.notFound",
  notDeletable: "errors.bookStatuses.notDeletable",
  codeExhausted: "errors.bookStatuses.codeExhausted",
  systemLocked: "errors.bookStatuses.systemLocked",
  deleteStateRequired: "errors.bookStatuses.deleteStateRequired",
  deleteStateInUse: "errors.bookStatuses.deleteStateInUse",
} as const;

export async function listBookStatusesHandler(
  db: BookStatusDb,
): Promise<BookStatusRow[]> {
  return listBookStatusRows(db);
}

export async function createBookStatusHandler(
  db: BookStatusDb,
  body: unknown,
): Promise<BookStatusRow> {
  const parsed = bookStatusCreateSchema.safeParse(body);
  if (!parsed.success) throw new AppError(BOOK_STATUS_ERRORS.invalidInput, 400);
  if (parsed.data.adminListHidden === true) {
    const conflict = await deleteStateConflict(db, null, true);
    if (typeof conflict === "number") {
      throw new AppError(BOOK_STATUS_ERRORS.deleteStateInUse, 409, {
        count: String(conflict),
      });
    }
  }
  const created = await createBookStatus(db, parsed.data);
  if (!created) throw new AppError(BOOK_STATUS_ERRORS.codeExhausted, 409);
  return created;
}

export async function updateBookStatusHandler(
  db: BookStatusDb,
  code: number,
  body: unknown,
): Promise<BookStatusRow> {
  if (!Number.isInteger(code) || code <= 0) {
    throw new AppError(BOOK_STATUS_ERRORS.invalidInput, 400);
  }
  const parsed = bookStatusUpdateSchema.safeParse(body);
  if (!parsed.success) throw new AppError(BOOK_STATUS_ERRORS.invalidInput, 400);
  if (Object.keys(parsed.data).length === 0) {
    throw new AppError(BOOK_STATUS_ERRORS.invalidInput, 400);
  }
  // 系统行（显示 / 隐藏 / 已删除）的行为开关锁定：名称与配色可改，表单可选 /
  // 前台可见不可改——放开「已删除」的前台可见会让软删除的书直接从书架冒出来。
  // 按值比较而非按键存在：编辑框对任何行都带着这两个字段，原值未变必须放行，
  // 否则改一个系统行的名字都会 400。管理页对系统行禁用这两个开关，这里是兜底。
  const current = (await listBookStatusRows(db)).find((row) => row.code === code);
  if (!current) throw new AppError(BOOK_STATUS_ERRORS.notFound, 404);
  if (current.isSystem
    && ((parsed.data.formSelectable !== undefined
        && parsed.data.formSelectable !== current.formSelectable)
      || (parsed.data.publicVisible !== undefined
        && parsed.data.publicVisible !== current.publicVisible))) {
    throw new AppError(BOOK_STATUS_ERRORS.systemLocked, 400);
  }
  // 删除态：只能转移到别的行，不能直接取消；旧持有行还挂着书时拒绝转移。
  if (parsed.data.adminListHidden !== undefined) {
    const conflict = await deleteStateConflict(
      db,
      code,
      parsed.data.adminListHidden,
    );
    if (conflict === "required") {
      throw new AppError(BOOK_STATUS_ERRORS.deleteStateRequired, 409);
    }
    if (typeof conflict === "number") {
      throw new AppError(BOOK_STATUS_ERRORS.deleteStateInUse, 409, {
        count: String(conflict),
      });
    }
  }
  const updated = await updateBookStatus(db, code, parsed.data);
  if (!updated) throw new AppError(BOOK_STATUS_ERRORS.notFound, 404);
  return updated;
}

export async function deleteBookStatusHandler(
  db: BookStatusDb,
  code: number,
): Promise<{deleted: true}> {
  if (!Number.isInteger(code) || code <= 0) {
    throw new AppError(BOOK_STATUS_ERRORS.invalidInput, 400);
  }
  const deleted = await deleteBookStatus(db, code);
  if (!deleted) throw new AppError(BOOK_STATUS_ERRORS.notDeletable, 409);
  return {deleted: true};
}
