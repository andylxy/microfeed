/**
 * 独立「名词」模块（ADR-0060）的纯读写层。
 *
 * 只碰 `ming_ci` 表（迁移 0177），**不写** `items`/`channels`/`ext_*`——与既有
 * 名词机制完全解耦（两套名词模型并行共存，ADR-0060 决策 2）。
 *
 * 删除分两步（与 `purgeAdminBook` / `deleteBookInfo` 同口径）：
 * - `softDeleteMingCi`（软删）只写 `deleted_at`，行保留，看板用 `isDeleted` 区分；
 * - `purgeMingCi`（物删）只删**已经软删**的行，不可恢复（见 docs/ming-ci/index.md）。
 */

import type {MingCiDb} from "./types";
import type {
  MingCiAdmin,
  MingCiInput,
} from "@/shared/MingCi";

function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** 可空文本列：null/空串 → null（看板形状是 `string | null`）。 */
function nullableText(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value);
  return s === "" ? null : s;
}

function toInt(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/** `ming_ci_list` 纯逗号文本 → `string[]`（对齐 netcore `GetAllMingCi` 的
 *  `Split(',')`，仅英文逗号）。空串/空值 → 空数组；丢弃空 token。
 *  迁移 0177 的列默认值仍是 `'[]'`（历史 JSON 形态），0187 归一化前按空数组处理。 */
function parseList(value: unknown): string[] {
  if (value == null) return [];
  const s = String(value).trim();
  if (s === "" || s === "[]") return [];
  return s.split(",").filter((token) => token !== "");
}

function nowIso(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

/** snake_case 行 → 看板形状。`isDeleted` 由 `deleted_at` 派生。 */
function rowToAdmin(row: Record<string, unknown>): MingCiAdmin {
  return {
    id: asText(row.id),
    mingCiNo: toInt(row.ming_ci_no, 0),
    mingCiName: asText(row.ming_ci_name),
    mingCiBeiMing: nullableText(row.ming_ci_bei_ming),
    mingCiText: asText(row.ming_ci_text),
    mingCiList: parseList(row.ming_ci_list),
    sourceBookId: nullableText(row.source_book_id),
    mingCiType: asText(row.ming_ci_type),
    showImage: nullableText(row.show_image),
    remark: nullableText(row.remark),
    isEnable: toInt(row.is_enable, 1) === 1,
    signatureId: nullableText(row.signature_id),
    signature: nullableText(row.signature),
    isDeleted: row.deleted_at != null,
  };
}

/** 整表看板：含已软删行（`isDeleted` 区分，供两步删除的第二段物删）。
 *  排序键 `ming_ci_no`（有唯一索引），种子 0–16 自然序。分组（settings）
 *  不在本层——store 只管 `ming_ci`，handler 合并 groups/sourceBooks。 */
export async function loadMingCiBoard(
  db: MingCiDb,
): Promise<MingCiAdmin[]> {
  const result = await db.prepare(
    "SELECT * FROM ming_ci ORDER BY ming_ci_no ASC, id ASC",
  ).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  return rows.map(rowToAdmin);
}

/** 单行读（主键点查）。 */
export async function getMingCi(
  db: MingCiDb,
  id: string,
): Promise<MingCiAdmin | null> {
  const row = await db.prepare(
    "SELECT * FROM ming_ci WHERE id = ?",
  ).bind(id).first();
  if (!row) return null;
  return rowToAdmin(row);
}

/** 下一个 `ming_ci_no`：`MAX(ming_ci_no)+1`（种子 max=16，next=17）。UNIQUE
 *  索引兜底，并发冲突走违反 fail-fast（不做静默合并）。 */
async function nextMingCiNo(db: MingCiDb): Promise<number> {
  const row = await db.prepare(
    "SELECT COALESCE(MAX(ming_ci_no), -1) AS max_no FROM ming_ci",
  ).first();
  return toInt(row?.max_no, -1) + 1;
}

/** 新建。`id` 由 handler 生成并已做过校验（见 handlers.ts）。
 *  `isEnable` 布尔 → `is_enable` 1/0；`mingCiList` string[] → 纯逗号文本
 *  （对齐 netcore `MingCiList` 落库形态）；
 *  可空字段空值写 null；`signature_id`/`signature` 新建不写（admin 不编辑，
 *  列位保留，App 签名链路另行处理）。 */
export async function createMingCi(
  db: MingCiDb,
  id: string,
  input: MingCiInput,
): Promise<MingCiAdmin> {
  const ts = nowIso();
  const no = await nextMingCiNo(db);
  await db.prepare(
    "INSERT INTO ming_ci " +
      "(id, ming_ci_no, ming_ci_name, ming_ci_bei_ming, ming_ci_text, ming_ci_list, " +
      " source_book_id, ming_ci_type, show_image, remark, is_enable, " +
      " signature_id, signature, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    id,
    no,
    input.mingCiName,
    input.mingCiBeiMing ?? null,
    input.mingCiText,
    (input.mingCiList ?? []).join(","),
    input.sourceBookId ?? null,
    input.mingCiType,
    input.showImage ?? null,
    input.remark ?? null,
    input.isEnable === false ? 0 : 1,
    null,
    null,
    ts,
    ts,
  ).run();
  const created = await getMingCi(db, id);
  if (!created) throw new Error("mingCi create did not read back");
  return created;
}

/** 合并式更新：先读当前行，把 patch 覆写进去再整行写回。`undefined` 字段
 *  保持原值，`null` 字段显式清空（非空列由 Zod 层拒绝写成 null）。
 *
 * 逐字段合并而非 spread：`MingCiInput` 用 `| null` 表示「显式清空」、
 * `MingCiAdmin` 用 `string | null` 表示空列，spread 会把类型并错。 */
export async function updateMingCi(
  db: MingCiDb,
  id: string,
  patch: Partial<MingCiInput>,
): Promise<MingCiAdmin | null> {
  const row = await db.prepare(
    "SELECT * FROM ming_ci WHERE id = ?",
  ).bind(id).first();
  if (!row) return null;
  const current = rowToAdmin(row);
  const mingCiName = patch.mingCiName ?? current.mingCiName;
  const mingCiBeiMing = patch.mingCiBeiMing === undefined
    ? current.mingCiBeiMing
    : patch.mingCiBeiMing ?? null;
  const mingCiText = patch.mingCiText ?? current.mingCiText;
  const mingCiList = patch.mingCiList === undefined
    ? current.mingCiList
    : patch.mingCiList;
  const sourceBookId = patch.sourceBookId === undefined
    ? current.sourceBookId
    : patch.sourceBookId ?? null;
  const mingCiType = patch.mingCiType ?? current.mingCiType;
  const showImage = patch.showImage === undefined
    ? current.showImage
    : patch.showImage ?? null;
  const remark = patch.remark === undefined
    ? current.remark
    : patch.remark ?? null;
  const isEnable = patch.isEnable ?? current.isEnable;
  await db.prepare(
    "UPDATE ming_ci SET " +
      "ming_ci_name = ?, ming_ci_bei_ming = ?, ming_ci_text = ?, " +
      "ming_ci_list = ?, source_book_id = ?, ming_ci_type = ?, " +
      "show_image = ?, remark = ?, is_enable = ?, updated_at = ? " +
      "WHERE id = ?",
  ).bind(
    mingCiName,
    mingCiBeiMing,
    mingCiText,
    mingCiList.join(","),
    sourceBookId,
    mingCiType,
    showImage,
    remark,
    isEnable ? 1 : 0,
    nowIso(),
    id,
  ).run();
  return getMingCi(db, id);
}

/** 改派：把 `from` 组的整批名词挪到 `to` 组（删组前先改派，ADR-0060 决策 4）。
 *  按 `ming_ci_type` 定位（有 0177 索引），非全表扫描。 */
export async function reassignMingCiType(
  db: MingCiDb,
  from: string,
  to: string,
): Promise<void> {
  await db.prepare(
    "UPDATE ming_ci SET ming_ci_type = ?, updated_at = ? " +
      "WHERE ming_ci_type = ?",
  ).bind(to, nowIso(), from).run();
}

/** 某组在册（未软删）名词数。删组前校验用（>0 拒删或强制改派）。 */
export async function countMingCiByType(
  db: MingCiDb,
  type: string,
): Promise<number> {
  const row = await db.prepare(
    "SELECT COUNT(*) AS c FROM ming_ci WHERE ming_ci_type = ? AND deleted_at IS NULL",
  ).bind(type).first();
  return toInt(row?.c, 0);
}

/** 软删：只写 `deleted_at`。行已删或不存在返回 false（已删行不重复删）。 */
export async function softDeleteMingCi(
  db: MingCiDb,
  id: string,
): Promise<boolean> {
  const row = await db.prepare(
    "SELECT id, deleted_at FROM ming_ci WHERE id = ?",
  ).bind(id).first();
  if (!row) return false;
  if (row.deleted_at != null) return false;
  await db.prepare(
    "UPDATE ming_ci SET deleted_at = ?, updated_at = ? WHERE id = ?",
  ).bind(nowIso(), nowIso(), id).run();
  return true;
}

export type PurgeMingCiResult =
  | {purged: true}
  | {purged: false; reason: "missing" | "notDeleted"};

/** 物删：只删**已软删**的行（两步删除第二段），不可恢复。不存在按 missing
 *  报，未软删按 notDeleted 报——把「打错 id」与「还没删过」分开。 */
export async function purgeMingCi(
  db: MingCiDb,
  id: string,
): Promise<PurgeMingCiResult> {
  const row = await db.prepare(
    "SELECT id, deleted_at FROM ming_ci WHERE id = ?",
  ).bind(id).first();
  if (!row) return {purged: false, reason: "missing"};
  if (row.deleted_at == null) return {purged: false, reason: "notDeleted"};
  await db.prepare("DELETE FROM ming_ci WHERE id = ?").bind(id).run();
  return {purged: true};
}
