/**
 * 独立「书本信息」模块（ADR-0058）的 handler 层。
 *
 * 与 `book-handlers.ts` 同构：Zod 校验请求体，然后交给 `store.ts`（纯读写）。
 * 5 个 handler 对应后台 5 条 ajax 路由（看板/新建/更新/软删/物删），
 * 无公共 api/v1——模块只给后台用（ADR-0058 决策 5）。
 */

import {z} from "zod";

import {AppError} from "@/shared/errors";
import {randomShortUUID} from "@/shared/StringUtils";
import type {BookInfoDb} from "./types";
import type {
  BookInfoAdmin,
  BookInfoBoard,
  BookInfoGroup,
  BookInfoStatus,
} from "@/shared/BookInfo";
import {
  createBookInfo,
  deleteBookInfo,
  loadBookInfoBoard,
  purgeBookInfo,
  reassignBookGroup,
  updateBookInfo,
} from "./store";
import {
  bookInfoGroupsSchema,
  loadBookGroups,
  saveBookGroups,
} from "./groups";
import {
  bookInfoStatusesSchema,
  loadBookStatuses,
  saveBookStatuses,
} from "./statuses";

const bookNameField = z.string().trim().min(1).max(255);
const caseDivisionField = z.string().trim().min(1).max(255);
/** 迁移 0173 起 `book_no`/`case_tag` 是文本列，排序键改 `book_name`。 */
const bookNoField = z.string().trim().min(1).max(255);
const caseTagField = z.string().trim().max(255);
/** 迁移 0173 起 `hot_book` 是 NOT NULL 状态值；是否在状态清单内由 handler 按清单校验。 */
const hotBookField = z.number().int();
const optionalText = (max: number) => z.string().trim().max(max);
const nullableText = (max: number) =>
  optionalText(max).nullable().optional();
const optionalInt = z.number().int().nullable().optional();

/** 改派载荷：`from`/`to` 都是非空分组键，且不能相同（自己改派给自己无意义）。 */
const reassignGroupSchema = z.object({
  from: z.string().trim().min(1),
  to: z.string().trim().min(1),
}).refine((value) => value.from !== value.to, {message: "same_group"});

export const bookInfoCreateSchema = z.object({
  bookName: bookNameField,
  chapter: optionalInt,
  author: nullableText(255),
  chengShu: nullableText(255),
  caseDivision: caseDivisionField,
  caseTag: caseTagField.optional(),
  bookNo: bookNoField,
  imageUrl: nullableText(255),
  hotBook: hotBookField,
  isEnable: z.boolean().optional(),
  comment: nullableText(255),
});

/** 更新 = 建表 schema 的全字段可缺省；非空列仍不可写成 null（`.partial()`
 *  不把 `.nullable()` 加进来）。 */
export const bookInfoUpdateSchema = bookInfoCreateSchema.partial();

export const BOOK_INFO_ERRORS = {
  invalidInput: "errors.bookInfo.invalidInput",
  notFound: "errors.bookInfo.notFound",
  purgeNeedsDelete: "errors.bookInfo.purgeNeedsDelete",
  /** 最后一个分组不可删：`case_division` NOT NULL，删了无处改派（ADR-0059 决策 5）。 */
  lastGroup: "errors.bookInfo.lastGroup",
  /** 状态清单不可清空：`hot_book` NOT NULL，清了无值可写（迁移 0173/0174）。 */
  lastStatus: "errors.bookInfo.lastStatus",
  /** `hot_book` 不在状态清单内：状态下拉的取值必须来自 settings 清单。 */
  invalidStatus: "errors.bookInfo.invalidStatus",
} as const;

/** 校验 `hot_book` 是状态清单内的取值（fail-closed：空清单 → 任何取值都拒）。 */
function assertHotBookInStatuses(
  hotBook: number,
  statuses: BookInfoStatus[],
): void {
  if (!statuses.some((status) => status.value === hotBook)) {
    throw new AppError(BOOK_INFO_ERRORS.invalidStatus, 400);
  }
}

/** 看板一次取齐：分组（settings）+ 状态（settings）+ 书（`book_info`）。
 *  两侧 db 在调用方是同一个 `env.FEED_DB`，但分组/状态走 settings 通道、书走
 *  book_info 端口，故分开接（ADR-0059 决策 5「一次性返回」）。 */
export async function listBookInfoBoardHandler(
  db: BookInfoDb,
  groupsDb: D1Database,
): Promise<BookInfoBoard> {
  const [groups, statuses, books] = await Promise.all([
    loadBookGroups(groupsDb),
    loadBookStatuses(groupsDb),
    loadBookInfoBoard(db),
  ]);
  return {groups, statuses, books};
}

/** 分组清单（settings）。 */
export async function listBookGroupsHandler(
  groupsDb: D1Database,
): Promise<BookInfoGroup[]> {
  return loadBookGroups(groupsDb);
}

/** 整表覆盖写分组清单。空清单 = 删掉最后一个分组 → 400（`case_division` NOT NULL，
 *  删了无处改派；ADR-0059 决策 5）。 */
export async function saveBookGroupsHandler(
  groupsDb: D1Database,
  body: unknown,
): Promise<{groups: BookInfoGroup[]}> {
  const parsed = bookInfoGroupsSchema.safeParse(body);
  if (!parsed.success) throw new AppError(BOOK_INFO_ERRORS.invalidInput, 400);
  if (parsed.data.groups.length === 0) {
    throw new AppError(BOOK_INFO_ERRORS.lastGroup, 400);
  }
  await saveBookGroups(groupsDb, parsed.data.groups);
  return {groups: parsed.data.groups};
}

/** 状态清单（settings）。 */
export async function listBookStatusesHandler(
  groupsDb: D1Database,
): Promise<BookInfoStatus[]> {
  return loadBookStatuses(groupsDb);
}

/** 整表覆盖写状态清单。空清单 = 删光状态 → 400（`hot_book` NOT NULL，
 *  清了无值可写；迁移 0173/0174）。 */
export async function saveBookStatusesHandler(
  groupsDb: D1Database,
  body: unknown,
): Promise<{statuses: BookInfoStatus[]}> {
  const parsed = bookInfoStatusesSchema.safeParse(body);
  if (!parsed.success) throw new AppError(BOOK_INFO_ERRORS.invalidInput, 400);
  if (parsed.data.statuses.length === 0) {
    throw new AppError(BOOK_INFO_ERRORS.lastStatus, 400);
  }
  await saveBookStatuses(groupsDb, parsed.data.statuses);
  return {statuses: parsed.data.statuses};
}

/** 改派：把 `from` 组的书整批挪到 `to` 组（删组前先改派，ADR-0059 决策 5）。 */
export async function reassignBookGroupHandler(
  db: BookInfoDb,
  body: unknown,
): Promise<{reassigned: true}> {
  const parsed = reassignGroupSchema.safeParse(body);
  if (!parsed.success) throw new AppError(BOOK_INFO_ERRORS.invalidInput, 400);
  await reassignBookGroup(db, parsed.data.from, parsed.data.to);
  return {reassigned: true};
}

export async function createBookInfoHandler(
  db: BookInfoDb,
  groupsDb: D1Database,
  body: unknown,
): Promise<BookInfoAdmin> {
  const parsed = bookInfoCreateSchema.safeParse(body);
  if (!parsed.success) throw new AppError(BOOK_INFO_ERRORS.invalidInput, 400);
  // id 在这里生成（store 保持纯读写）。
  const id = randomShortUUID();
  assertHotBookInStatuses(parsed.data.hotBook, await loadBookStatuses(groupsDb));
  return createBookInfo(db, id, parsed.data);
}

export async function updateBookInfoHandler(
  db: BookInfoDb,
  groupsDb: D1Database,
  id: string,
  body: unknown,
): Promise<BookInfoAdmin> {
  if (!id) throw new AppError(BOOK_INFO_ERRORS.invalidInput, 400);
  const parsed = bookInfoUpdateSchema.safeParse(body);
  if (!parsed.success) throw new AppError(BOOK_INFO_ERRORS.invalidInput, 400);
  if (Object.keys(parsed.data).length === 0) {
    throw new AppError(BOOK_INFO_ERRORS.invalidInput, 400);
  }
  if (parsed.data.hotBook !== undefined) {
    assertHotBookInStatuses(parsed.data.hotBook, await loadBookStatuses(groupsDb));
  }
  const updated = await updateBookInfo(db, id, parsed.data);
  if (!updated) throw new AppError(BOOK_INFO_ERRORS.notFound, 404);
  return updated;
}

export async function deleteBookInfoHandler(
  db: BookInfoDb,
  id: string,
): Promise<{deleted: true}> {
  if (!id) throw new AppError(BOOK_INFO_ERRORS.invalidInput, 400);
  const deleted = await deleteBookInfo(db, id);
  if (!deleted) throw new AppError(BOOK_INFO_ERRORS.notFound, 404);
  return {deleted: true};
}

export async function purgeBookInfoHandler(
  db: BookInfoDb,
  id: string,
): Promise<{purged: true}> {
  if (!id) throw new AppError(BOOK_INFO_ERRORS.invalidInput, 400);
  const result = await purgeBookInfo(db, id);
  if (!result.purged) {
    if (result.reason === "notDeleted") {
      throw new AppError(BOOK_INFO_ERRORS.purgeNeedsDelete, 409);
    }
    throw new AppError(BOOK_INFO_ERRORS.notFound, 404);
  }
  return {purged: true};
}
