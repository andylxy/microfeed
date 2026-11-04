/**
 * 独立「本草」模块（ADR-0061）的纯读写层。
 *
 * 只碰 `zhong_yao` 表（迁移 0180），**不写** `items`/`channels`/`ext_*`/
 * `settings`——与既有中药机制完全解耦（两套中药模型并行共存，ADR-0061 决策 2）。
 *
 * 删除分两步（与 `purgeMingCi` / `purgeAdminBook` 同口径）：
 * - `softDeleteZhongYao`（软删）只写 `deleted_at`，行保留，看板用 `isDeleted` 区分；
 * - `purgeZhongYao`（物删）只删**已经软删**的行，不可恢复。
 *
 * **无分组**（对比 ADR-0060 ming-ci store）：无 `reassign`/`countByType`——源
 * 实体无分类字段，不伪造推导分组（ADR-0061 决策 3）。
 */

import type {ZhongYaoDb} from "./types";
import type {
  ZhongYaoAdmin,
  ZhongYaoInput,
} from "@/shared/ZhongYao";

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

/** `zhong_yao_list` JSON 数组字符串 → `string[]`。坏值回落空数组（宽松，仅显示）。 */
function parseList(value: unknown): string[] {
  if (value == null) return [];
  const s = String(value);
  try {
    const arr: unknown = JSON.parse(s);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function nowIso(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

/** snake_case 行 → 看板形状。`isDeleted` 由 `deleted_at` 派生。 */
function rowToAdmin(row: Record<string, unknown>): ZhongYaoAdmin {
  return {
    id: asText(row.id),
    zhongYaoNo: toInt(row.zhong_yao_no, 0),
    zhongYaoName: asText(row.zhong_yao_name),
    zhongYaoBeiMing: nullableText(row.zhong_yao_bei_ming),
    zhongYaoText: asText(row.zhong_yao_text),
    zhongYaoList: parseList(row.zhong_yao_list),
    isEnable: toInt(row.is_enable, 1) === 1,
    signatureId: nullableText(row.signature_id),
    signature: nullableText(row.signature),
    isDeleted: row.deleted_at != null,
  };
}

/** 整表看板：含已软删行（`isDeleted` 区分，供两步删除的第二段物删）。
 *  排序键 `zhong_yao_no`（有唯一索引），种子 0–171 自然序。 */
export async function loadZhongYaoBoard(
  db: ZhongYaoDb,
): Promise<ZhongYaoAdmin[]> {
  // d1scan:ignore 整表看板 ORDER BY zhong_yao_no 全序：表仅 172 行，索引全扫（zhong_yao_no_unique）即最优计划——免表扫+外排、补索引无收益，实测 0.04ms。
  const result = await db.prepare(
    "SELECT * FROM zhong_yao ORDER BY zhong_yao_no ASC, id ASC",
  ).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  return rows.map(rowToAdmin);
}

/** 单行读（主键点查）。 */
export async function getZhongYao(
  db: ZhongYaoDb,
  id: string,
): Promise<ZhongYaoAdmin | null> {
  const row = await db.prepare(
    "SELECT * FROM zhong_yao WHERE id = ?",
  ).bind(id).first();
  if (!row) return null;
  return rowToAdmin(row);
}

/** 下一个 `zhong_yao_no`：`MAX(zhong_yao_no)+1`（种子 max=171，next=172）。
 *  UNIQUE 索引兜底，并发冲突走违反 fail-fast（不做静默合并）。 */
async function nextZhongYaoNo(db: ZhongYaoDb): Promise<number> {
  const row = await db.prepare(
    "SELECT COALESCE(MAX(zhong_yao_no), -1) AS max_no FROM zhong_yao",
  ).first();
  return toInt(row?.max_no, -1) + 1;
}

/** 新建。`id` 由 handler 生成并已做过校验（见 handlers.ts）。
 *  `isEnable` 布尔 → `is_enable` 1/0；`zhongYaoList` string[] → JSON 字符串；
 *  可空字段空值写 null；`signature_id`/`signature` 新建不写（admin 不编辑，
 *  列位保留，App 签名链路另行处理）。 */
export async function createZhongYao(
  db: ZhongYaoDb,
  id: string,
  input: ZhongYaoInput,
): Promise<ZhongYaoAdmin> {
  const ts = nowIso();
  const no = await nextZhongYaoNo(db);
  await db.prepare(
    "INSERT INTO zhong_yao " +
      "(id, zhong_yao_no, zhong_yao_name, zhong_yao_bei_ming, zhong_yao_text, " +
      " zhong_yao_list, is_enable, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    id,
    no,
    input.zhongYaoName,
    input.zhongYaoBeiMing ?? null,
    input.zhongYaoText,
    JSON.stringify(input.zhongYaoList ?? []),
    input.isEnable === false ? 0 : 1,
    ts,
    ts,
  ).run();
  const created = await getZhongYao(db, id);
  if (!created) throw new Error("zhongYao create did not read back");
  return created;
}

/** 合并式更新：先读当前行，把 patch 覆写进去再整行写回。`undefined` 字段
 *  保持原值，`null` 字段显式清空（非空列由 Zod 层拒绝写成 null）。
 *
 * 逐字段合并而非 spread：`ZhongYaoInput` 用 `| null` 表示「显式清空」、
 * `ZhongYaoAdmin` 用 `string | null` 表示空列，spread 会把类型并错。 */
export async function updateZhongYao(
  db: ZhongYaoDb,
  id: string,
  patch: Partial<ZhongYaoInput>,
): Promise<ZhongYaoAdmin | null> {
  const row = await db.prepare(
    "SELECT * FROM zhong_yao WHERE id = ?",
  ).bind(id).first();
  if (!row) return null;
  const current = rowToAdmin(row);
  const zhongYaoName = patch.zhongYaoName ?? current.zhongYaoName;
  const zhongYaoBeiMing = patch.zhongYaoBeiMing === undefined
    ? current.zhongYaoBeiMing
    : patch.zhongYaoBeiMing ?? null;
  const zhongYaoText = patch.zhongYaoText ?? current.zhongYaoText;
  const zhongYaoList = patch.zhongYaoList === undefined
    ? current.zhongYaoList
    : patch.zhongYaoList;
  const isEnable = patch.isEnable ?? current.isEnable;
  await db.prepare(
    "UPDATE zhong_yao SET " +
      "zhong_yao_name = ?, zhong_yao_bei_ming = ?, zhong_yao_text = ?, " +
      "zhong_yao_list = ?, is_enable = ?, updated_at = ? " +
      "WHERE id = ?",
  ).bind(
    zhongYaoName,
    zhongYaoBeiMing,
    zhongYaoText,
    JSON.stringify(zhongYaoList),
    isEnable ? 1 : 0,
    nowIso(),
    id,
  ).run();
  return getZhongYao(db, id);
}

/** 软删：只写 `deleted_at`。行已删或不存在返回 false（已删行不重复删）。 */
export async function softDeleteZhongYao(
  db: ZhongYaoDb,
  id: string,
): Promise<boolean> {
  const row = await db.prepare(
    "SELECT id, deleted_at FROM zhong_yao WHERE id = ?",
  ).bind(id).first();
  if (!row) return false;
  if (row.deleted_at != null) return false;
  await db.prepare(
    "UPDATE zhong_yao SET deleted_at = ?, updated_at = ? WHERE id = ?",
  ).bind(nowIso(), nowIso(), id).run();
  return true;
}

export type PurgeZhongYaoResult =
  | {purged: true}
  | {purged: false; reason: "missing" | "notDeleted"};

/** 物删：只删**已软删**的行（两步删除第二段），不可恢复。不存在按 missing
 *  报，未软删按 notDeleted 报——把「打错 id」与「还没删过」分开。 */
export async function purgeZhongYao(
  db: ZhongYaoDb,
  id: string,
): Promise<PurgeZhongYaoResult> {
  const row = await db.prepare(
    "SELECT id, deleted_at FROM zhong_yao WHERE id = ?",
  ).bind(id).first();
  if (!row) return {purged: false, reason: "missing"};
  if (row.deleted_at == null) return {purged: false, reason: "notDeleted"};
  await db.prepare("DELETE FROM zhong_yao WHERE id = ?").bind(id).run();
  return {purged: true};
}
