/**
 * 独立「药材别名」模块（ADR-0064）的纯读写层。
 *
 * 只碰 `yao_alia` 表（迁移 0183），**不写** `items`/`channels`/`ext_*`/
 * `settings`/`zhong_yao`/`book_chapter*`——与 App 三源派生别名链路完全解耦
 * （两套别名模型并行共存，ADR-0064 决策 1/2）。
 *
 * 删除分两步（与 `purgeZhongYao` / `purgeMingCi` / `purgeAdminBook` 同口径）：
 * - `softDeleteYaoAlia`（软删）只写 `deleted_at`，行保留，看板用 `isDeleted` 区分；
 *   软删行仍占用 `yao_alia_bie_ming` 唯一键，要复用同名别名须先物删；
 * - `purgeYaoAlia`（物删）只删**已经软删**的行，不可恢复。
 *
 * **无分组读写**（对比 ADR-0060 ming-ci store）：无 `reassign`/`countByType`——
 * 左栏按正名 `yaoName` 分组是 UI 客户端只读派生（ADR-0064 决策 3），server 不
 * 返回 groups、无 groups/reassign 端点、零 settings 读写。
 */

import type {YaoAliaDb} from "./types";
import type {
  YaoAliaAdmin,
  YaoAliaInput,
} from "@/shared/YaoAlia";

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

function nowIso(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

/** snake_case 行 → 看板形状。`isDeleted` 由 `deleted_at` 派生。
 *  `bieMing`/`yaoName` 是 NOT NULL 列，正常不为 null；`asText` 兜底空串防脏数据。 */
function rowToAdmin(row: Record<string, unknown>): YaoAliaAdmin {
  return {
    id: asText(row.id),
    yaoAliaNo: toInt(row.yao_alia_no, 0),
    bieMing: asText(row.yao_alia_bie_ming),
    yaoName: asText(row.yao_alia_name),
    isEnable: toInt(row.is_enable, 1) === 1,
    signatureId: nullableText(row.signature_id),
    signature: nullableText(row.signature),
    isDeleted: row.deleted_at != null,
  };
}

/** 整表看板：含已软删行（`isDeleted` 区分，供两步删除的第二段物删）。
 *  排序键 `yao_alia_no`（有唯一索引），种子 1–47 自然序。 */
export async function loadYaoAliaBoard(
  db: YaoAliaDb,
): Promise<YaoAliaAdmin[]> {
  // d1scan:ignore 整表看板 ORDER BY yao_alia_no 全序：表仅 47 行（种子）+ 后台新增行，
  // 索引全扫（yao_alia_no_unique）即最优计划——免表扫+外排、补索引无收益。实测 0.10ms。
  const result = await db.prepare(
    "SELECT * FROM yao_alia ORDER BY yao_alia_no ASC, id ASC",
  ).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  return rows.map(rowToAdmin);
}

/** 单行读（主键点查）。 */
export async function getYaoAlia(
  db: YaoAliaDb,
  id: string,
): Promise<YaoAliaAdmin | null> {
  const row = await db.prepare(
    "SELECT * FROM yao_alia WHERE id = ?",
  ).bind(id).first();
  if (!row) return null;
  return rowToAdmin(row);
}

/** 下一个 `yao_alia_no`：`MAX(yao_alia_no)+1`（种子 max=47，next=48）。
 *  UNIQUE 索引兜底，并发冲突走违反 fail-fast（不做静默合并）。 */
async function nextYaoAliaNo(db: YaoAliaDb): Promise<number> {
  const row = await db.prepare(
    "SELECT COALESCE(MAX(yao_alia_no), 0) AS max_no FROM yao_alia",
  ).first();
  return toInt(row?.max_no, 0) + 1;
}

/** 新建。`id` 由 handler 生成并已做过校验（见 handlers.ts）。
 *  `isEnable` 布尔 → `is_enable` 1/0；`signature_id`/`signature` 新建不写
 *  （admin 不编辑，列位保留，源全 NULL）。 */
export async function createYaoAlia(
  db: YaoAliaDb,
  id: string,
  input: YaoAliaInput,
): Promise<YaoAliaAdmin> {
  const ts = nowIso();
  const no = await nextYaoAliaNo(db);
  await db.prepare(
    "INSERT INTO yao_alia " +
      "(id, yao_alia_no, yao_alia_bie_ming, yao_alia_name, is_enable, " +
      " created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    id,
    no,
    input.bieMing,
    input.yaoName,
    input.isEnable === false ? 0 : 1,
    ts,
    ts,
  ).run();
  const created = await getYaoAlia(db, id);
  if (!created) throw new Error("yaoAlia create did not read back");
  return created;
}

/** 合并式更新：先读当前行，把 patch 覆写进去再整行写回。`undefined` 字段
 *  保持原值（Zod 层已拒空串，故给值即非空，不会把 NOT NULL 列写空）。
 *
 * 逐字段合并而非 spread：编辑 `yaoName` 会即时重算左栏分组（UI 客户端派生，
 * 无 settings 写入），这是 ADR-0064 决策 3 的关键行为。 */
export async function updateYaoAlia(
  db: YaoAliaDb,
  id: string,
  patch: Partial<YaoAliaInput>,
): Promise<YaoAliaAdmin | null> {
  const row = await db.prepare(
    "SELECT * FROM yao_alia WHERE id = ?",
  ).bind(id).first();
  if (!row) return null;
  const current = rowToAdmin(row);
  const bieMing = patch.bieMing ?? current.bieMing;
  const yaoName = patch.yaoName ?? current.yaoName;
  const isEnable = patch.isEnable ?? current.isEnable;
  await db.prepare(
    "UPDATE yao_alia SET " +
      "yao_alia_bie_ming = ?, yao_alia_name = ?, is_enable = ?, updated_at = ? " +
      "WHERE id = ?",
  ).bind(
    bieMing,
    yaoName,
    isEnable ? 1 : 0,
    nowIso(),
    id,
  ).run();
  return getYaoAlia(db, id);
}

/** 软删：只写 `deleted_at`。行已删或不存在返回 false（已删行不重复删）。
 *  软删行仍占用 `yao_alia_bie_ming` 唯一键。 */
export async function softDeleteYaoAlia(
  db: YaoAliaDb,
  id: string,
): Promise<boolean> {
  const row = await db.prepare(
    "SELECT id, deleted_at FROM yao_alia WHERE id = ?",
  ).bind(id).first();
  if (!row) return false;
  if (row.deleted_at != null) return false;
  await db.prepare(
    "UPDATE yao_alia SET deleted_at = ?, updated_at = ? WHERE id = ?",
  ).bind(nowIso(), nowIso(), id).run();
  return true;
}

export type PurgeYaoAliaResult =
  | {purged: true}
  | {purged: false; reason: "missing" | "notDeleted"};

/** 物删：只删**已软删**的行（两步删除第二段），不可恢复。不存在按 missing
 *  报，未软删按 notDeleted 报——把「打错 id」与「还没删过」分开。物删释放
 *  `yao_alia_bie_ming` 唯一键，同名别名才可复用。 */
export async function purgeYaoAlia(
  db: YaoAliaDb,
  id: string,
): Promise<PurgeYaoAliaResult> {
  const row = await db.prepare(
    "SELECT id, deleted_at FROM yao_alia WHERE id = ?",
  ).bind(id).first();
  if (!row) return {purged: false, reason: "missing"};
  if (row.deleted_at == null) return {purged: false, reason: "notDeleted"};
  await db.prepare("DELETE FROM yao_alia WHERE id = ?").bind(id).run();
  return {purged: true};
}
