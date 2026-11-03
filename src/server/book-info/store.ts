/**
 * 独立「书本信息」模块（ADR-0058）的纯读写层。
 *
 * 只碰 `book_info` 表（迁移 0171），**不写** `channels`/`items`、不依赖
 * `ext_book_stats`/`ext_book_status`/`ext_category`——与既有书机制完全解耦。
 *
 * 删除分两步（与 `purgeAdminBook` 同口径）：
 * - `deleteBookInfo`（软删）只写 `deleted_at`，行保留，误删可恢复思路在——
 *   但本模块暂无 restore，看板用 `isDeleted` 区分，已软删行只给物删；
 * - `purgeBookInfo`（物删）只删**已经软删**的行，不可恢复，且不级联
 *   `parent_id` 子行（`parent_id` 是逻辑自引用、无外键，孤儿归属超出本票范围，
 *   见 docs/book-info/index.md）。
 */

import type {BookInfoDb} from "./types";
import type {
  BookInfoAdmin,
  BookInfoInput,
} from "@/shared/BookInfo";

function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function nullableText(value: unknown): string | null {
  return value == null ? null : asText(value);
}

function toInt(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function nullableInt(value: unknown): number | null {
  if (value == null) return null;
  const n = toInt(value, Number.NaN);
  return Number.isFinite(n) ? n : null;
}

function nowIso(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

/** snake_case 行 → 看板形状。`isDeleted` 由 `deleted_at` 派生。 */
function rowToAdmin(row: Record<string, unknown>): BookInfoAdmin {
  return {
    id: asText(row.id),
    bookName: asText(row.book_name),
    chapter: nullableInt(row.chapter),
    author: asText(row.author),
    chengShu: asText(row.cheng_shu),
    caseDivision: asText(row.case_division),
    caseTag: asText(row.case_tag),
    bookNo: asText(row.book_no),
    imageUrl: asText(row.image_url),
    hotBook: toInt(row.hot_book, 0),
    parentId: nullableText(row.parent_id),
    orgId: nullableInt(row.org_id),
    isEnable: toInt(row.is_enable, 1) === 1,
    comment: asText(row.comment),
    isDeleted: row.deleted_at != null,
  };
}

/** 整表看板：含已软删行（`isDeleted` 区分，供两步删除的第二段物删）。
 *  迁移 0173 起 `book_no` 是文本列，排序键改 `book_name`（有索引），同号语义
 *  不再适用，按 id 稳定化；分组（settings）不在本层——store 只管 `book_info`，
 *  handler 合并 groups。 */
export async function loadBookInfoBoard(
  db: BookInfoDb,
): Promise<BookInfoAdmin[]> {
  const result = await db.prepare(
    "SELECT * FROM book_info ORDER BY book_name ASC, id ASC",
  ).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  return rows.map(rowToAdmin);
}

/** 单行读（主键点查）。 */
export async function getBookInfo(
  db: BookInfoDb,
  id: string,
): Promise<BookInfoAdmin | null> {
  const row = await db.prepare(
    "SELECT * FROM book_info WHERE id = ?",
  ).bind(id).first();
  if (!row) return null;
  return rowToAdmin(row);
}

/** 新建。`id` 由 handler 生成并已做过自引用校验（见 handlers.ts）。
 *  `isEnable` 布尔 → `is_enable` 1/0；`hot_book` 是状态值（NOT NULL，handler 已
 *  校验在状态清单内）；空串可空字段写 null。 */
export async function createBookInfo(
  db: BookInfoDb,
  id: string,
  input: BookInfoInput,
): Promise<BookInfoAdmin> {
  const ts = nowIso();
  await db.prepare(
    "INSERT INTO book_info " +
      "(id, book_name, chapter, author, cheng_shu, case_division, case_tag, " +
      " book_no, image_url, hot_book, parent_id, org_id, is_enable, comment, " +
      " created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    id,
    input.bookName,
    input.chapter ?? null,
    input.author || null,
    input.chengShu || null,
    input.caseDivision,
    input.caseTag ?? "",
    input.bookNo,
    input.imageUrl || null,
    input.hotBook,
    input.parentId || null,
    input.orgId ?? null,
    input.isEnable === false ? 0 : 1,
    input.comment || null,
    ts,
    ts,
  ).run();
  const created = await getBookInfo(db, id);
  if (!created) throw new Error("bookInfo create did not read back");
  return created;
}

/** 合并式更新：先读当前行，把 patch 覆写进去再整行写回。`undefined` 字段
 *  保持原值，`null` 字段显式清空（非空列由 Zod 层拒绝写成 null）。
 *
 * 逐字段合并而非 spread：`BookInfoInput` 用 `| null` 表示「显式清空」、
 * `BookInfoAdmin` 用空串表示空列，两者对同一列的类型不同（如 `author`），
 * spread 会把可空并进结果让 `BookInfoAdmin` 赋值失败。 */
export async function updateBookInfo(
  db: BookInfoDb,
  id: string,
  patch: Partial<BookInfoInput>,
): Promise<BookInfoAdmin | null> {
  const row = await db.prepare(
    "SELECT * FROM book_info WHERE id = ?",
  ).bind(id).first();
  if (!row) return null;
  const current = rowToAdmin(row);
  const bookName = patch.bookName ?? current.bookName;
  const chapter = patch.chapter === undefined ? current.chapter : patch.chapter;
  const author = patch.author === undefined ? current.author : patch.author ?? "";
  const chengShu = patch.chengShu === undefined
    ? current.chengShu
    : patch.chengShu ?? "";
  const caseDivision = patch.caseDivision ?? current.caseDivision;
  const caseTag = patch.caseTag ?? current.caseTag;
  const bookNo = patch.bookNo ?? current.bookNo;
  const imageUrl = patch.imageUrl === undefined
    ? current.imageUrl
    : patch.imageUrl ?? "";
  const hotBook = patch.hotBook ?? current.hotBook;
  const parentId = patch.parentId === undefined
    ? current.parentId
    : patch.parentId ?? null;
  const orgId = patch.orgId === undefined ? current.orgId : patch.orgId;
  const isEnable = patch.isEnable ?? current.isEnable;
  const comment = patch.comment === undefined
    ? current.comment
    : patch.comment ?? "";
  await db.prepare(
    "UPDATE book_info SET " +
      "book_name = ?, chapter = ?, author = ?, cheng_shu = ?, " +
      "case_division = ?, case_tag = ?, book_no = ?, image_url = ?, " +
      "hot_book = ?, parent_id = ?, org_id = ?, is_enable = ?, comment = ?, " +
      "updated_at = ? " +
      "WHERE id = ?",
  ).bind(
    bookName,
    chapter ?? null,
    author || null,
    chengShu || null,
    caseDivision,
    caseTag,
    bookNo,
    imageUrl || null,
    hotBook,
    parentId || null,
    orgId ?? null,
    isEnable ? 1 : 0,
    comment || null,
    nowIso(),
    id,
  ).run();
  return getBookInfo(db, id);
}

/** 改派：把 `from` 组的书整批挪到 `to` 组（删组前先改派，ADR-0059 决策 5）。
 *  按 `case_division` 定位（有 0172 索引），非全表扫描。命名不带 Info，与
 *  handler 的 `reassignBookGroupHandler` 对齐，避免误读成 Book（channels 行）。 */
export async function reassignBookGroup(
  db: BookInfoDb,
  from: string,
  to: string,
): Promise<void> {
  await db.prepare(
    "UPDATE book_info SET case_division = ?, updated_at = ? " +
      "WHERE case_division = ?",
  ).bind(to, nowIso(), from).run();
}

/** 软删：只写 `deleted_at`。行已删或不存在返回 false（已删行不重复删）。 */
export async function deleteBookInfo(
  db: BookInfoDb,
  id: string,
): Promise<boolean> {
  const row = await db.prepare(
    "SELECT id, deleted_at FROM book_info WHERE id = ?",
  ).bind(id).first();
  if (!row) return false;
  if (row.deleted_at != null) return false;
  await db.prepare(
    "UPDATE book_info SET deleted_at = ?, updated_at = ? WHERE id = ?",
  ).bind(nowIso(), nowIso(), id).run();
  return true;
}

export type PurgeBookInfoResult =
  | {purged: true}
  | {purged: false; reason: "missing" | "notDeleted"};

/** 物删：只删**已软删**的行（两步删除第二段），不可恢复。不存在按 missing
 *  报，未软删按 notDeleted 报——把「打错 id」与「还没删过」分开。 */
export async function purgeBookInfo(
  db: BookInfoDb,
  id: string,
): Promise<PurgeBookInfoResult> {
  const row = await db.prepare(
    "SELECT id, deleted_at FROM book_info WHERE id = ?",
  ).bind(id).first();
  if (!row) return {purged: false, reason: "missing"};
  if (row.deleted_at == null) return {purged: false, reason: "notDeleted"};
  await db.prepare("DELETE FROM book_info WHERE id = ?").bind(id).run();
  return {purged: true};
}
