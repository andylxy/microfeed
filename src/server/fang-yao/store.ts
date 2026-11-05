/**
 * 独立「方剂」模块（ADR-0065）的纯读写层。
 *
 * 只碰 `fang_yao` / `fang_yao_body`（迁移 0184 + 导入脚本），**不写**
 * `items`/`channels`/`ext_*`/`zhong_yao`/`book_chapter`/`book_info`——与既有
 * items 方剂机制（legacy `fangs` 页）完全解耦，并行共存（ADR-0065 决策 1）。
 *
 * ## 格式保真（ADR-0065 决策 4）
 *
 * 文本列读写**一律不 trim、不 strip、不归一换行、不折叠空白**。方文的前导
 * 缩进、句号后空格、真实换行、制表符都是内容。本层只做形状转换
 * （snake_case ↔ camelCase）与 NULL 归一，绝不动字符。`fang_text` 的花括号
 * 已在导入脚本里配平，读写层不再改写。
 *
 * ## `fang_no` 系统托管（ADR-0065 P1 甲）
 *
 * 源 FangNo 组内重复 + 跨书重叠，不可作键。本层 `fang_no` 走**组内 MAX+1**
 * （同 `source_book_legacy_id` 内连续，换源书组从 1 重开），UNIQUE 索引兜底，
 * 并发冲突 fail-fast。**绝不读、绝不复用源 FangNo。**
 *
 * 删除分两步（与 `purgeBookChapter`/`purgeMingCi` 同口径）：
 * - `softDelete*`（软删）只写 `deleted_at`，行保留，看板用 `isDeleted` 区分；
 * - `purge*`（物删）只删**已经软删**的行，不可恢复。
 */

import type {FangYaoDb} from "./types";
import type {
  FangYaoAdmin,
  FangYaoBodyAdmin,
  FangYaoBodyInput,
  FangYaoInput,
} from "@/shared/FangYao";

function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** 可空文本列：null → null。**空串保留空串**——只有 `null` 才是「没有值」，
 *  空串是数据（源 YaoList 的 `''→NULL` 归一发生在导入期，不在读写层二次加工）。 */
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

/** 合并式更新字段：`undefined` 保持原值，`null`/空值显式清空，否则取新值。
 *  updateFangYao 与 updateFangYaoBody 共用（ADR-0065：可空字段「缺省不改、null 清空」）。 */
function mergeNullable<T>(current: T | null, patchValue: T | null | undefined): T | null {
  return patchValue === undefined ? current : patchValue ?? null;
}

/** snake_case 方剂行 → 看板形状。`isDeleted` 由 `deleted_at` 派生。 */
function rowToAdmin(row: Record<string, unknown>): FangYaoAdmin {
  return {
    id: asText(row.id),
    fangNo: toInt(row.fang_no, 0),
    fangName: asText(row.fang_name),
    sourceBookLegacyId: nullableText(row.source_book_legacy_id),
    sourceBookName: nullableText(row.source_book_name),
    sourceFangLegacyId: nullableText(row.source_fang_legacy_id),
    yaoList: nullableText(row.yao_list),
    fangText: asText(row.fang_text),
    fangDrinkNum: nullableText(row.fang_drink_num),
    isEnable: toInt(row.is_enable, 1) === 1,
    signatureId: nullableText(row.signature_id),
    signature: nullableText(row.signature),
    isDeleted: row.deleted_at != null,
    yaoCount: toInt(row.yao_count, 0),
  };
}

/** snake_case 组成行 → 看板形状。 */
function rowToBodyAdmin(row: Record<string, unknown>): FangYaoBodyAdmin {
  return {
    id: asText(row.id),
    fangYaoId: asText(row.fang_yao_id),
    position: toInt(row.position, 0),
    showName: nullableText(row.show_name),
    amount: nullableText(row.amount),
    extraProcess: nullableText(row.extra_process),
    weight: nullableText(row.weight),
    yaoLegacyId: nullableText(row.yao_legacy_id),
    isEnable: toInt(row.is_enable, 1) === 1,
    signatureId: nullableText(row.signature_id),
    signature: nullableText(row.signature),
    isDeleted: row.deleted_at != null,
  };
}

// ---------------------------------------------------------------------------
// 方剂主表
// ---------------------------------------------------------------------------

/** 整表看板：含已软删行（`isDeleted` 区分，供两步删除的第二段物删）。
 *  排序按 `source_book_legacy_id`（左栏分组键）再 `fang_no`（组内连续）。
 *  组聚合（`FangYaoSourceGroup`）在 handler 层派生——store 只管 `fang_yao`。 */
export async function loadFangYaoBoard(
  db: FangYaoDb,
): Promise<FangYaoAdmin[]> {
  // d1scan:ignore 整表看板 ORDER BY source_book_legacy_id, fang_no 全序：表仅 804 行，走 fang_yao_book_no 索引即最优计划——免表扫+外排、补索引无收益。yao_count 走相关子查询（fang_yao_body_fang 索引点查，804 次 O(1)），读侧派生不物化。
  const result = await db.prepare(
    "SELECT f.*, (SELECT COUNT(*) FROM fang_yao_body b WHERE b.fang_yao_id = f.id AND b.deleted_at IS NULL) AS yao_count " +
    "FROM fang_yao f ORDER BY f.source_book_legacy_id ASC, f.fang_no ASC, f.id ASC",
  ).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  return rows.map(rowToAdmin);
}

/** 单行读（主键点查）。 */
export async function getFangYao(
  db: FangYaoDb,
  id: string,
): Promise<FangYaoAdmin | null> {
  const row = await db.prepare(
    "SELECT f.*, (SELECT COUNT(*) FROM fang_yao_body b WHERE b.fang_yao_id = f.id AND b.deleted_at IS NULL) AS yao_count " +
    "FROM fang_yao f WHERE f.id = ?",
  ).bind(id).first();
  if (!row) return null;
  return rowToAdmin(row);
}

/** 同一源书组内下一个 `fang_no`：`MAX(fang_no)+1`，换源书组从 1 重开。
 *  用 `IS ?` 而非 `= ?`：`source_book_legacy_id` 可为 NULL（未归属源书组），
 *  `= NULL` 永假会把空值组全并成一个 MAX。UNIQUE(source_book_legacy_id, fang_no)
 *  索引兜底，并发冲突走违反 fail-fast（不做静默合并）。 */
async function nextFangNo(
  db: FangYaoDb,
  sourceBookLegacyId: string | null,
): Promise<number> {
  const row = await db.prepare(
    "SELECT COALESCE(MAX(fang_no), 0) AS max_no FROM fang_yao " +
      "WHERE source_book_legacy_id IS ?",
  ).bind(sourceBookLegacyId).first();
  return toInt(row?.max_no, 0) + 1;
}

/** 新建方剂。`id` 由 handler 生成并已校验。`fang_no` 组内 MAX+1 托管。
 *  `signature_id`/`signature`/`source_fang_legacy_id` 新建不写（admin 不编辑，
 *  列位保留）。文本原样入库。 */
export async function createFangYao(
  db: FangYaoDb,
  id: string,
  input: FangYaoInput,
): Promise<FangYaoAdmin> {
  const ts = nowIso();
  const sourceBookLegacyId = input.sourceBookLegacyId ?? null;
  const fangNo = await nextFangNo(db, sourceBookLegacyId);
  await db.prepare(
    "INSERT INTO fang_yao " +
      "(id, fang_no, fang_name, source_book_legacy_id, source_book_name, " +
      " yao_list, fang_text, fang_drink_num, is_enable, " +
      " signature_id, signature, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    id,
    fangNo,
    input.fangName,
    sourceBookLegacyId,
    input.sourceBookName ?? null,
    input.yaoList ?? null,
    input.fangText,
    input.fangDrinkNum ?? null,
    input.isEnable === false ? 0 : 1,
    null,
    null,
    ts,
    ts,
  ).run();
  const created = await getFangYao(db, id);
  if (!created) throw new Error("fangYao create did not read back");
  return created;
}

/** 合并式更新：先读当前行，把 patch 覆写进去再整行写回。`undefined` 字段
 *  保持原值，`null` 字段显式清空。`fang_no` **系统托管、不可改**。 */
export async function updateFangYao(
  db: FangYaoDb,
  id: string,
  patch: Partial<FangYaoInput>,
): Promise<FangYaoAdmin | null> {
  const row = await db.prepare(
    "SELECT f.*, (SELECT COUNT(*) FROM fang_yao_body b WHERE b.fang_yao_id = f.id AND b.deleted_at IS NULL) AS yao_count " +
    "FROM fang_yao f WHERE f.id = ?",
  ).bind(id).first();
  if (!row) return null;
  const current = rowToAdmin(row);
  const fangName = patch.fangName ?? current.fangName;
  // sourceBookLegacyId/sourceBookName 只读（ADR-0065：源 BookId 追溯 + 导入派生
  // 组名）——编辑不改写，只由 createFangYao 设置。若允许改动，旧 fang_no 会随行
  // 移入新书源组而撞 UNIQUE(source_book_legacy_id, fang_no) 或带错组序号。
  const sourceBookLegacyId = current.sourceBookLegacyId;
  const sourceBookName = current.sourceBookName;
  const yaoList = mergeNullable(current.yaoList, patch.yaoList);
  const fangText = patch.fangText ?? current.fangText;
  const fangDrinkNum = mergeNullable(current.fangDrinkNum, patch.fangDrinkNum);
  const isEnable = patch.isEnable ?? current.isEnable;
  await db.prepare(
    "UPDATE fang_yao SET " +
      "fang_name = ?, source_book_legacy_id = ?, source_book_name = ?, " +
      "yao_list = ?, fang_text = ?, fang_drink_num = ?, is_enable = ?, " +
      "updated_at = ? WHERE id = ?",
  ).bind(
    fangName,
    sourceBookLegacyId,
    sourceBookName,
    yaoList,
    fangText,
    fangDrinkNum,
    isEnable ? 1 : 0,
    nowIso(),
    id,
  ).run();
  return getFangYao(db, id);
}

/** 软删：只写 `deleted_at`。行已删或不存在返回 false。 */
export async function softDeleteFangYao(
  db: FangYaoDb,
  id: string,
): Promise<boolean> {
  const row = await db.prepare(
    "SELECT id, deleted_at FROM fang_yao WHERE id = ?",
  ).bind(id).first();
  if (!row) return false;
  if (row.deleted_at != null) return false;
  const ts = nowIso();
  await db.prepare(
    "UPDATE fang_yao SET deleted_at = ?, updated_at = ? WHERE id = ?",
  ).bind(ts, ts, id).run();
  return true;
}

export type PurgeFangYaoResult =
  | {purged: true}
  | {purged: false; reason: "missing" | "notDeleted" | "hasBodies"};

/** 物删：只删**已软删**的方剂，不可恢复。
 *
 *  方剂下还有组成行时拒绝删除：组成靠 `fang_yao_id` 引用方剂，直接删方剂会
 *  留下指向不存在方剂的孤儿组成（后台详情页再也取不到）。 */
export async function purgeFangYao(
  db: FangYaoDb,
  id: string,
): Promise<PurgeFangYaoResult> {
  const row = await db.prepare(
    "SELECT id, deleted_at FROM fang_yao WHERE id = ?",
  ).bind(id).first();
  if (!row) return {purged: false, reason: "missing"};
  if (row.deleted_at == null) return {purged: false, reason: "notDeleted"};
  if ((await countBodiesByFang(db, id)) > 0) {
    return {purged: false, reason: "hasBodies"};
  }
  await db.prepare("DELETE FROM fang_yao WHERE id = ?").bind(id).run();
  return {purged: true};
}

/** 某方剂下的组成条数（含已软删）。删方剂前提示、UI 计数用。 */
export async function countBodiesByFang(
  db: FangYaoDb,
  fangYaoId: string,
): Promise<number> {
  const row = await db.prepare(
    "SELECT COUNT(*) AS c FROM fang_yao_body WHERE fang_yao_id = ?",
  ).bind(fangYaoId).first();
  return toInt(row?.c, 0);
}

// ---------------------------------------------------------------------------
// 方剂组成
// ---------------------------------------------------------------------------

/** 某方剂的组成列表（含已软删），按 `position` 稳定排序。
 *  走 `fang_yao_id` 索引窄范围取，不整表扫（2025 行）。 */
export async function listBodiesByFang(
  db: FangYaoDb,
  fangYaoId: string,
): Promise<FangYaoBodyAdmin[]> {
  const result = await db.prepare(
    "SELECT * FROM fang_yao_body WHERE fang_yao_id = ? " +
      "ORDER BY position ASC, id ASC",
  ).bind(fangYaoId).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  return rows.map(rowToBodyAdmin);
}

/** 单行读组成（主键点查）。 */
export async function getFangYaoBody(
  db: FangYaoDb,
  id: string,
): Promise<FangYaoBodyAdmin | null> {
  const row = await db.prepare(
    "SELECT * FROM fang_yao_body WHERE id = ?",
  ).bind(id).first();
  if (!row) return null;
  return rowToBodyAdmin(row);
}

/** 方内下一个 `position`：`MAX(position)+1`。源 position 是方内唯一有序键，
 *  新建组成沿用同一语义。 */
async function nextPosition(
  db: FangYaoDb,
  fangYaoId: string,
): Promise<number> {
  const row = await db.prepare(
    "SELECT COALESCE(MAX(position), 0) AS max_no FROM fang_yao_body " +
      "WHERE fang_yao_id = ?",
  ).bind(fangYaoId).first();
  return toInt(row?.max_no, 0) + 1;
}

/** 新建组成。`signature_id`/`signature` 新建不写（admin 不编辑，列位保留）。 */
export async function createFangYaoBody(
  db: FangYaoDb,
  id: string,
  fangYaoId: string,
  input: FangYaoBodyInput,
): Promise<FangYaoBodyAdmin> {
  const ts = nowIso();
  const position = input.position ?? (await nextPosition(db, fangYaoId));
  await db.prepare(
    "INSERT INTO fang_yao_body " +
      "(id, fang_yao_id, position, show_name, amount, extra_process, weight, " +
      " yao_legacy_id, is_enable, signature_id, signature, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    id,
    fangYaoId,
    position,
    input.showName ?? null,
    input.amount ?? null,
    input.extraProcess ?? null,
    input.weight ?? null,
    input.yaoLegacyId ?? null,
    input.isEnable === false ? 0 : 1,
    null,
    null,
    ts,
    ts,
  ).run();
  const created = await getFangYaoBody(db, id);
  if (!created) throw new Error("fangYaoBody create did not read back");
  return created;
}

/** 合并式更新组成。序号 `position` **系统托管、不可改**——始终保留原值，
 *  即使载荷带了 `position` 也忽略（前端已禁用该框，这里兜底防 API 直改）。
 *  文本原样写回，不 trim。 */
export async function updateFangYaoBody(
  db: FangYaoDb,
  id: string,
  patch: Partial<FangYaoBodyInput>,
): Promise<FangYaoBodyAdmin | null> {
  const row = await db.prepare(
    "SELECT * FROM fang_yao_body WHERE id = ?",
  ).bind(id).first();
  if (!row) return null;
  const current = rowToBodyAdmin(row);
  const position = current.position;
  const showName = mergeNullable(current.showName, patch.showName);
  const amount = mergeNullable(current.amount, patch.amount);
  const extraProcess = mergeNullable(current.extraProcess, patch.extraProcess);
  const weight = mergeNullable(current.weight, patch.weight);
  const yaoLegacyId = mergeNullable(current.yaoLegacyId, patch.yaoLegacyId);
  const isEnable = patch.isEnable ?? current.isEnable;
  await db.prepare(
    "UPDATE fang_yao_body SET " +
      "position = ?, show_name = ?, amount = ?, extra_process = ?, " +
      "weight = ?, yao_legacy_id = ?, is_enable = ?, updated_at = ? " +
      "WHERE id = ?",
  ).bind(
    position,
    showName,
    amount,
    extraProcess,
    weight,
    yaoLegacyId,
    isEnable ? 1 : 0,
    nowIso(),
    id,
  ).run();
  return getFangYaoBody(db, id);
}

/** 软删组成：只写 `deleted_at`。 */
export async function softDeleteFangYaoBody(
  db: FangYaoDb,
  id: string,
): Promise<boolean> {
  const row = await db.prepare(
    "SELECT id, deleted_at FROM fang_yao_body WHERE id = ?",
  ).bind(id).first();
  if (!row) return false;
  if (row.deleted_at != null) return false;
  const ts = nowIso();
  await db.prepare(
    "UPDATE fang_yao_body SET deleted_at = ?, updated_at = ? WHERE id = ?",
  ).bind(ts, ts, id).run();
  return true;
}

export type PurgeFangYaoBodyResult =
  | {purged: true}
  | {purged: false; reason: "missing" | "notDeleted"};

/** 物删组成：只删**已软删**的行，不可恢复。 */
export async function purgeFangYaoBody(
  db: FangYaoDb,
  id: string,
): Promise<PurgeFangYaoBodyResult> {
  const row = await db.prepare(
    "SELECT id, deleted_at FROM fang_yao_body WHERE id = ?",
  ).bind(id).first();
  if (!row) return {purged: false, reason: "missing"};
  if (row.deleted_at == null) return {purged: false, reason: "notDeleted"};
  await db.prepare("DELETE FROM fang_yao_body WHERE id = ?").bind(id).run();
  return {purged: true};
}
