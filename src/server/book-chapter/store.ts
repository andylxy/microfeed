/**
 * 独立「书本卷章」模块（ADR-0062）的纯读写层。
 *
 * 只碰 `book_chapter` / `book_chapter_body`（迁移 0181/0182 + 导入脚本），
 * **不写** `items`/`channels`/`ext_*`/`zhong_yao`——与既有 items-卷章机制
 * 完全解耦（两套卷章模型并行共存，ADR-0062 决策 1）。
 *
 * ## 格式保真（ADR-0062 决策 6）
 *
 * 文本列读写**一律不 trim、不 strip、不归一换行、不折叠空白**。正文的
 * 前导缩进、句号后空格、真实换行与字面 CR 都是内容。本层只做形状转换
 * （snake_case ↔ camelCase）与 NULL 归一，绝不动字符。
 *
 * 删除分两步（与 `purgeMingCi`/`deleteBookInfo` 同口径）：
 * - `softDelete*`（软删）只写 `deleted_at`，行保留，看板用 `isDeleted` 区分；
 * - `purge*`（物删）只删**已经软删**的行，不可恢复。
 */

import type {BookChapterDb} from "./types";
import type {
  BookChapterAdmin,
  BookChapterBodyAdmin,
  BookChapterBodyInput,
  BookChapterInput,
} from "@/shared/BookChapter";

function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** 可空文本列：null → null。**空串保留空串**——只有 `null` 才是「没有值」，
 *  空串是数据（源 FangJi 的 `''→NULL` 归一发生在导入期，不在读写层做二次加工）。 */
function nullableText(value: unknown): string | null {
  if (value == null) return null;
  return String(value);
}

function toInt(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function nowIso(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

/** snake_case 卷章行 → 看板形状。`isDeleted` 由 `deleted_at` 派生。 */
function rowToAdmin(row: Record<string, unknown>): BookChapterAdmin {
  return {
    id: asText(row.id),
    chapterNo: toInt(row.chapter_no, 0),
    chapterHeader: asText(row.chapter_header),
    sourceBookId: nullableText(row.source_book_id),
    sourceBookName: nullableText(row.source_book_name),
    sourceBookLegacyId: nullableText(row.source_book_legacy_id),
    chapterSection: nullableText(row.chapter_section),
    isEnable: toInt(row.is_enable, 1) === 1,
    signatureId: nullableText(row.signature_id),
    signature: nullableText(row.signature),
    isDeleted: row.deleted_at != null,
  };
}

/** snake_case 正文行 → 看板形状。 */
function rowToBodyAdmin(row: Record<string, unknown>): BookChapterBodyAdmin {
  return {
    id: asText(row.id),
    bookChapterId: asText(row.book_chapter_id),
    receiptNo: toInt(row.receipt_no, 0),
    sectionText: asText(row.section_text),
    sectionNote: nullableText(row.section_note),
    fangJi: nullableText(row.fang_ji),
    fangJiZhujie: nullableText(row.fang_ji_zhujie),
    bieMing: nullableText(row.bie_ming),
    bencaoYaoName: nullableText(row.bencao_yao_name),
    bencaoLevel: nullableText(row.bencao_level),
    isEnable: toInt(row.is_enable, 1) === 1,
    signatureId: nullableText(row.signature_id),
    signature: nullableText(row.signature),
    isDeleted: row.deleted_at != null,
  };
}

// ---------------------------------------------------------------------------
// 卷章目录
// ---------------------------------------------------------------------------

/** 整表看板：含已软删行（`isDeleted` 区分，供两步删除的第二段物删）。
 *  排序键 `chapter_no`（唯一索引），种子 1..445 自然序。来源书下拉不在本层——
 *  store 只管 `book_chapter`，handler 合并 `book_info`。 */
export async function loadBookChapterBoard(
  db: BookChapterDb,
): Promise<BookChapterAdmin[]> {
  // d1scan:ignore 整表看板 ORDER BY chapter_no 全序：表仅 445 行，索引全扫（book_chapter_no_unique）即最优计划——免表扫+外排、补索引无收益，实测 0.07ms。
  const result = await db.prepare(
    "SELECT * FROM book_chapter ORDER BY chapter_no ASC, id ASC",
  ).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  return rows.map(rowToAdmin);
}

/** 单行读（主键点查）。 */
export async function getBookChapter(
  db: BookChapterDb,
  id: string,
): Promise<BookChapterAdmin | null> {
  const row = await db.prepare(
    "SELECT * FROM book_chapter WHERE id = ?",
  ).bind(id).first();
  if (!row) return null;
  return rowToAdmin(row);
}

/** 下一个 `chapter_no`：`MAX(chapter_no)+1`（种子 max=445，next=446）。
 *  UNIQUE 索引兜底，并发冲突走违反 fail-fast（不做静默合并）。 */
async function nextChapterNo(db: BookChapterDb): Promise<number> {
  const row = await db.prepare(
    "SELECT COALESCE(MAX(chapter_no), 0) AS max_no FROM book_chapter",
  ).first();
  return toInt(row?.max_no, 0) + 1;
}

/** 新建卷章。`id` 由 handler 生成并已校验。`signature_id`/`signature`
 *  新建不写（admin 不编辑，列位保留）。文本原样入库。 */
export async function createBookChapter(
  db: BookChapterDb,
  id: string,
  input: BookChapterInput,
): Promise<BookChapterAdmin> {
  const ts = nowIso();
  const chapterNo = await nextChapterNo(db);
  await db.prepare(
    "INSERT INTO book_chapter " +
      "(id, chapter_no, chapter_header, source_book_id, source_book_name, " +
      " source_book_legacy_id, chapter_section, is_enable, " +
      " signature_id, signature, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    id,
    chapterNo,
    input.chapterHeader,
    input.sourceBookId ?? null,
    input.sourceBookName ?? null,
    null,
    input.chapterSection ?? null,
    input.isEnable === false ? 0 : 1,
    null,
    null,
    ts,
    ts,
  ).run();
  const created = await getBookChapter(db, id);
  if (!created) throw new Error("bookChapter create did not read back");
  return created;
}

/** 合并式更新：先读当前行，把 patch 覆写进去再整行写回。`undefined` 字段
 *  保持原值，`null` 字段显式清空。逐字段合并而非 spread（`| null` 语义）。 */
export async function updateBookChapter(
  db: BookChapterDb,
  id: string,
  patch: Partial<BookChapterInput>,
): Promise<BookChapterAdmin | null> {
  const row = await db.prepare(
    "SELECT * FROM book_chapter WHERE id = ?",
  ).bind(id).first();
  if (!row) return null;
  const current = rowToAdmin(row);
  const chapterHeader = patch.chapterHeader ?? current.chapterHeader;
  const sourceBookId = patch.sourceBookId === undefined
    ? current.sourceBookId
    : patch.sourceBookId ?? null;
  const sourceBookName = patch.sourceBookName === undefined
    ? current.sourceBookName
    : patch.sourceBookName ?? null;
  const chapterSection = patch.chapterSection === undefined
    ? current.chapterSection
    : patch.chapterSection ?? null;
  const isEnable = patch.isEnable ?? current.isEnable;
  await db.prepare(
    "UPDATE book_chapter SET " +
      "chapter_header = ?, source_book_id = ?, source_book_name = ?, " +
      "chapter_section = ?, is_enable = ?, updated_at = ? " +
      "WHERE id = ?",
  ).bind(
    chapterHeader,
    sourceBookId,
    sourceBookName,
    chapterSection,
    isEnable ? 1 : 0,
    nowIso(),
    id,
  ).run();
  return getBookChapter(db, id);
}

/** 软删：只写 `deleted_at`。行已删或不存在返回 false。 */
export async function softDeleteBookChapter(
  db: BookChapterDb,
  id: string,
): Promise<boolean> {
  const row = await db.prepare(
    "SELECT id, deleted_at FROM book_chapter WHERE id = ?",
  ).bind(id).first();
  if (!row) return false;
  if (row.deleted_at != null) return false;
  const ts = nowIso();
  await db.prepare(
    "UPDATE book_chapter SET deleted_at = ?, updated_at = ? WHERE id = ?",
  ).bind(ts, ts, id).run();
  return true;
}

export type PurgeBookChapterResult =
  | {purged: true}
  | {purged: false; reason: "missing" | "notDeleted" | "hasBodies"};

/** 物删：只删**已软删**的卷章，不可恢复。
 *
 *  卷章下还有正文行时拒绝删除：正文靠 `book_chapter_id` 引用卷章，
 *  直接删卷章会留下指向不存在卷章的孤儿正文（后台详情页再也取不到）。
 *  先删正文再删卷章，保持引用完整。 */
export async function purgeBookChapter(
  db: BookChapterDb,
  id: string,
): Promise<PurgeBookChapterResult> {
  const row = await db.prepare(
    "SELECT id, deleted_at FROM book_chapter WHERE id = ?",
  ).bind(id).first();
  if (!row) return {purged: false, reason: "missing"};
  if (row.deleted_at == null) return {purged: false, reason: "notDeleted"};
  if ((await countBodiesByChapter(db, id)) > 0) {
    return {purged: false, reason: "hasBodies"};
  }
  await db.prepare("DELETE FROM book_chapter WHERE id = ?").bind(id).run();
  return {purged: true};
}

/** 某卷章下的正文条数（含已软删）。删卷章前提示、UI 计数用。 */
export async function countBodiesByChapter(
  db: BookChapterDb,
  chapterId: string,
): Promise<number> {
  const row = await db.prepare(
    "SELECT COUNT(*) AS c FROM book_chapter_body WHERE book_chapter_id = ?",
  ).bind(chapterId).first();
  return toInt(row?.c, 0);
}

// ---------------------------------------------------------------------------
// 卷章正文
// ---------------------------------------------------------------------------

/** 某卷章的正文列表（含已软删），按 `receipt_no` 稳定排序。
 *  走 `book_chapter_id` 索引窄范围取，不整表扫（8066 行）。 */
export async function listBodiesByChapter(
  db: BookChapterDb,
  chapterId: string,
): Promise<BookChapterBodyAdmin[]> {
  const result = await db.prepare(
    "SELECT * FROM book_chapter_body WHERE book_chapter_id = ? " +
      "ORDER BY receipt_no ASC, id ASC",
  ).bind(chapterId).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  return rows.map(rowToBodyAdmin);
}

/** 单行读正文（主键点查）。 */
export async function getBookChapterBody(
  db: BookChapterDb,
  id: string,
): Promise<BookChapterBodyAdmin | null> {
  const row = await db.prepare(
    "SELECT * FROM book_chapter_body WHERE id = ?",
  ).bind(id).first();
  if (!row) return null;
  return rowToBodyAdmin(row);
}

/** 卷章内下一个 `receipt_no`：`MAX(receipt_no)+1`。源 receipt_no 是卷章内
 *  唯一有序键（审计 0 重复），新建正文沿用同一语义。 */
async function nextReceiptNo(
  db: BookChapterDb,
  chapterId: string,
): Promise<number> {
  const row = await db.prepare(
    "SELECT COALESCE(MAX(receipt_no), 0) AS max_no FROM book_chapter_body " +
      "WHERE book_chapter_id = ?",
  ).bind(chapterId).first();
  return toInt(row?.max_no, 0) + 1;
}

/** 新建正文。`bencao_yao_name`/`bencao_level` 是导入派生列，**新建不写**
 *  （admin 不编辑；本草条目的这两列只在导入脚本里产生）。 */
export async function createBookChapterBody(
  db: BookChapterDb,
  id: string,
  chapterId: string,
  input: BookChapterBodyInput,
): Promise<BookChapterBodyAdmin> {
  const ts = nowIso();
  const receiptNo = input.receiptNo ?? (await nextReceiptNo(db, chapterId));
  await db.prepare(
    "INSERT INTO book_chapter_body " +
      "(id, book_chapter_id, receipt_no, section_text, section_note, " +
      " fang_ji, fang_ji_zhujie, bie_ming, bencao_yao_name, bencao_level, " +
      " is_enable, signature_id, signature, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    id,
    chapterId,
    receiptNo,
    input.sectionText,
    input.sectionNote ?? null,
    input.fangJi ?? null,
    input.fangJiZhujie ?? null,
    input.bieMing ?? null,
    null,
    null,
    input.isEnable === false ? 0 : 1,
    null,
    null,
    ts,
    ts,
  ).run();
  const created = await getBookChapterBody(db, id);
  if (!created) throw new Error("bookChapterBody create did not read back");
  return created;
}

/** 合并式更新正文。序号 `receipt_no` **系统托管、不可改**——始终保留原值，
 *  即使载荷带了 `receiptNo` 也忽略（前端已禁用该框，这里兜底防 API 直改）。
 *  文本原样写回，不 trim。 */
export async function updateBookChapterBody(
  db: BookChapterDb,
  id: string,
  patch: Partial<BookChapterBodyInput>,
): Promise<BookChapterBodyAdmin | null> {
  const row = await db.prepare(
    "SELECT * FROM book_chapter_body WHERE id = ?",
  ).bind(id).first();
  if (!row) return null;
  const current = rowToBodyAdmin(row);
  const receiptNo = current.receiptNo;
  const sectionText = patch.sectionText ?? current.sectionText;
  const sectionNote = patch.sectionNote === undefined
    ? current.sectionNote
    : patch.sectionNote ?? null;
  const fangJi = patch.fangJi === undefined ? current.fangJi : patch.fangJi ?? null;
  const fangJiZhujie = patch.fangJiZhujie === undefined
    ? current.fangJiZhujie
    : patch.fangJiZhujie ?? null;
  const bieMing = patch.bieMing === undefined
    ? current.bieMing
    : patch.bieMing ?? null;
  const isEnable = patch.isEnable ?? current.isEnable;
  await db.prepare(
    "UPDATE book_chapter_body SET " +
      "receipt_no = ?, section_text = ?, section_note = ?, fang_ji = ?, " +
      "fang_ji_zhujie = ?, bie_ming = ?, is_enable = ?, updated_at = ? " +
      "WHERE id = ?",
  ).bind(
    receiptNo,
    sectionText,
    sectionNote,
    fangJi,
    fangJiZhujie,
    bieMing,
    isEnable ? 1 : 0,
    nowIso(),
    id,
  ).run();
  return getBookChapterBody(db, id);
}

/** 软删正文：只写 `deleted_at`。 */
export async function softDeleteBookChapterBody(
  db: BookChapterDb,
  id: string,
): Promise<boolean> {
  const row = await db.prepare(
    "SELECT id, deleted_at FROM book_chapter_body WHERE id = ?",
  ).bind(id).first();
  if (!row) return false;
  if (row.deleted_at != null) return false;
  const ts = nowIso();
  await db.prepare(
    "UPDATE book_chapter_body SET deleted_at = ?, updated_at = ? WHERE id = ?",
  ).bind(ts, ts, id).run();
  return true;
}

export type PurgeBookChapterBodyResult =
  | {purged: true}
  | {purged: false; reason: "missing" | "notDeleted"};

/** 物删正文：只删**已软删**的行，不可恢复。 */
export async function purgeBookChapterBody(
  db: BookChapterDb,
  id: string,
): Promise<PurgeBookChapterBodyResult> {
  const row = await db.prepare(
    "SELECT id, deleted_at FROM book_chapter_body WHERE id = ?",
  ).bind(id).first();
  if (!row) return {purged: false, reason: "missing"};
  if (row.deleted_at == null) return {purged: false, reason: "notDeleted"};
  await db.prepare("DELETE FROM book_chapter_body WHERE id = ?").bind(id).run();
  return {purged: true};
}
