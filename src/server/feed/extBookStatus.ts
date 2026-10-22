import {STATUSES} from "@/shared/Constants";
import type {BookStatusRow} from "@/shared/ExtBook";

export type {BookStatusRow};

/**
 * 书籍状态字典（迁移 0142）。
 *
 * 一本书是 `channels` 行，`channels.status` 存的是本表某一行的 `code`。搬迁前
 * 状态集合固定在常量、表单选项与前台查询里，新增一种状态要改代码再部署；现在
 * 「表单可选 / 前台可见 / 后台列表隐藏 / 系统保护」都是行上的开关，运营在
 * `/admin/book-statuses/` 自助增删。
 *
 * 行数规模：系统行 3 条 + 运营自建条数，本地实测 4 行。所有查询都是全表小读
 * （无 WHERE 过滤的也就 3–5 行），不给 public_visible / admin_list_hidden 建
 * 索引——为个位数行建索引只会让写入多维护一份结构。
 */

/** What the dashboard may set when creating a status. */
export interface BookStatusInput {
  nameZh: string;
  nameEn: string;
  formSelectable?: boolean;
  publicVisible?: boolean;
  /** 设为删除态：全表只有一个，写入时清掉旧持有行（见 createBookStatus）。 */
  adminListHidden?: boolean;
  sort?: number;
  colorFg?: string | null;
  colorBg?: string | null;
}

/** What the dashboard may change on an existing status. */
export type BookStatusPatch = Partial<BookStatusInput>;

/** Minimal D1-shaped database port; a fake implements it for unit tests.
 *  Same pattern as `BookDb` / `CategoryDb`. */
export interface BookStatusDbRunResult {
  success: boolean;
}

export interface BookStatusDbAllResult {
  results: Record<string, unknown>[];
}

export interface BookStatusDbPreparedStatement {
  bind(...values: unknown[]): BookStatusDbPreparedStatement;
  run(): Promise<BookStatusDbRunResult>;
  all(): Promise<BookStatusDbAllResult>;
  first(): Promise<Record<string, unknown> | null>;
}

export interface BookStatusDb {
  prepare(query: string): BookStatusDbPreparedStatement;
}

/** Custom codes start here; 1–9 stay reserved for system semantics. */
const CUSTOM_CODE_FLOOR = 10;
const MAX_CODE = 127;
/** Sort gap between a new status and the current last row. */
const SORT_STEP = 100;

/** 空表时的退化读数：迁移未应用或被清空时，按系统默认继续服务，不让整站变空。 */
const FALLBACK_PUBLIC_CODES: readonly number[] = [STATUSES.PUBLISHED];
const FALLBACK_ADMIN_HIDDEN_CODES: readonly number[] = [STATUSES.DELETED];

function flag(value: unknown): boolean {
  return Number(value ?? 0) === 1;
}

function asInt(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nowIso(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function asColor(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function toRow(row: Record<string, unknown>): BookStatusRow {
  return {
    code: asInt(row.code),
    nameZh: typeof row.name_zh === "string" ? row.name_zh : "",
    nameEn: typeof row.name_en === "string" ? row.name_en : "",
    formSelectable: flag(row.form_selectable),
    publicVisible: flag(row.public_visible),
    adminListHidden: flag(row.admin_list_hidden),
    isSystem: flag(row.is_system),
    sort: asInt(row.sort),
    colorFg: asColor(row.color_fg),
    colorBg: asColor(row.color_bg),
  };
}

/** Every status row, in the order the dashboard lists them. */
export async function listBookStatusRows(db: BookStatusDb): Promise<BookStatusRow[]> {
  const result = await db.prepare(
    "SELECT code, name_zh, name_en, form_selectable, public_visible, " +
      "admin_list_hidden, is_system, sort, color_fg, color_bg " +
      "FROM ext_book_status ORDER BY sort ASC, code ASC",
  ).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  return rows.map(toRow);
}

/** The codes a book create/update may switch to. */
export async function listFormSelectableStatusCodes(
  db: BookStatusDb,
): Promise<number[]> {
  const rows = await listBookStatusRows(db);
  // 空表（迁移未应用 / 被清空）时退回系统默认，与另两个读取同口径；表里有行
  // 但一行都不可选是运营自己的配置，如实返回空，由页面上的开关补救。
  if (rows.length === 0) return [STATUSES.PUBLISHED, STATUSES.UNPUBLISHED];
  return rows.filter((row) => row.formSelectable).map((row) => row.code);
}

/** Codes the public site may show (shelf / category / search / detail pages). */
export async function listPublicVisibleStatusCodes(
  db: BookStatusDb,
): Promise<number[]> {
  const rows = await listBookStatusRows(db);
  if (rows.length === 0) return [...FALLBACK_PUBLIC_CODES];
  return rows.filter((row) => row.publicVisible).map((row) => row.code);
}

/** Codes the admin book list hides (the soft-delete state). */
export async function listAdminListHiddenCodes(
  db: BookStatusDb,
): Promise<number[]> {
  const rows = await listBookStatusRows(db);
  if (rows.length === 0) return [...FALLBACK_ADMIN_HIDDEN_CODES];
  return rows.filter((row) => row.adminListHidden).map((row) => row.code);
}

/** How many books sit on each status code — the manage page shows this so an
 *  operator can see what a delete would orphan.
 *
 *  读代价：`GROUP BY status` 走 `channels_status` 索引（迁移 0001），本地实测
 *  channels 13 行 → 读 13 行 / 约 1KB；生产按书的行数线性，无全表扫描。 */
export async function countChannelsByStatus(
  db: BookStatusDb,
): Promise<Map<number, number>> {
  const result = await db.prepare(
    "SELECT status, COUNT(*) AS n FROM channels GROUP BY status",
  ).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  const counts = new Map<number, number>();
  for (const row of rows) {
    const code = asInt(row.status, -1);
    if (code <= 0) continue;
    counts.set(code, asInt(row.n));
  }
  return counts;
}

/** Smallest free custom code, or null when 10–127 are all taken. Takes the
 *  already-read rows so a caller that needs the sort too reads once. */
export function nextBookStatusCode(
  rows: readonly BookStatusRow[],
): number | null {
  const used = new Set(rows.map((row) => row.code));
  for (let code = CUSTOM_CODE_FLOOR; code <= MAX_CODE; code += 1) {
    if (!used.has(code)) return code;
  }
  return null;
}

/**
 * Add a status. Returns null when no free code is left — the caller turns that
 * into a request error rather than inventing a code.
 *
 * The default sort sits after every existing row (+100 per new status), so a
 * freshly added status cannot jump ahead of the system rows and hijack the
 * book form's first option or the restore target.
 *
 * 删除态是全表唯一的标记：新建行要求当删除态时，先把旧持有行的标记清掉，
 * 保证 `listAdminListHiddenCodes` 始终只有一个码（软删除只写它）。
 */
export async function createBookStatus(
  db: BookStatusDb,
  input: BookStatusInput,
): Promise<BookStatusRow | null> {
  const rows = await listBookStatusRows(db);
  const code = nextBookStatusCode(rows);
  if (code == null) return null;
  const defaultSort = rows.reduce((highest, row) => Math.max(highest, row.sort), 0)
    + SORT_STEP;
  const adminListHidden = input.adminListHidden === true;
  if (adminListHidden) await clearDeleteState(db, code);
  await db.prepare(
    "INSERT INTO ext_book_status " +
      "(code, name_zh, name_en, form_selectable, public_visible, " +
      "admin_list_hidden, sort, color_fg, color_bg, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    code,
    input.nameZh,
    input.nameEn,
    input.formSelectable === false ? 0 : 1,
    input.publicVisible === true ? 1 : 0,
    adminListHidden ? 1 : 0,
    input.sort ?? defaultSort,
    input.colorFg ?? null,
    input.colorBg ?? null,
    nowIso(),
    nowIso(),
  ).run();
  const after = await listBookStatusRows(db);
  return after.find((row) => row.code === code) ?? null;
}

/** 把删除态从其它行上摘掉，让 `keep` 成为唯一持有者。 */
async function clearDeleteState(db: BookStatusDb, keep: number): Promise<void> {
  await db.prepare(
    "UPDATE ext_book_status SET admin_list_hidden = 0 WHERE code != ?",
  ).bind(keep).run();
}

/** Change the editable columns of a status. The code itself never moves. */
export async function updateBookStatus(
  db: BookStatusDb,
  code: number,
  patch: BookStatusPatch,
): Promise<BookStatusRow | null> {
  const existing = await db.prepare(
    "SELECT code FROM ext_book_status WHERE code = ?",
  ).bind(code).first();
  if (!existing) return null;
  // 删除态只能转移，不能凭空取消：先清旧持有行，再把标记给这一行。
  if (patch.adminListHidden === true) await clearDeleteState(db, code);

  const assignments: string[] = [];
  const values: unknown[] = [];
  if (patch.nameZh !== undefined) {
    assignments.push("name_zh = ?");
    values.push(patch.nameZh);
  }
  if (patch.nameEn !== undefined) {
    assignments.push("name_en = ?");
    values.push(patch.nameEn);
  }
  if (patch.formSelectable !== undefined) {
    assignments.push("form_selectable = ?");
    values.push(patch.formSelectable ? 1 : 0);
  }
  if (patch.publicVisible !== undefined) {
    assignments.push("public_visible = ?");
    values.push(patch.publicVisible ? 1 : 0);
  }
  if (patch.adminListHidden !== undefined) {
    assignments.push("admin_list_hidden = ?");
    values.push(patch.adminListHidden ? 1 : 0);
  }
  if (patch.sort !== undefined) {
    assignments.push("sort = ?");
    values.push(patch.sort);
  }
  if (patch.colorFg !== undefined) {
    assignments.push("color_fg = ?");
    values.push(patch.colorFg);
  }
  if (patch.colorBg !== undefined) {
    assignments.push("color_bg = ?");
    values.push(patch.colorBg);
  }
  if (assignments.length === 0) {
    const rows = await listBookStatusRows(db);
    return rows.find((row) => row.code === code) ?? null;
  }
  assignments.push("updated_at = ?");
  values.push(nowIso(), code);
  await db.prepare(
    `UPDATE ext_book_status SET ${assignments.join(", ")} WHERE code = ?`,
  ).bind(...values).run();
  const rows = await listBookStatusRows(db);
  return rows.find((row) => row.code === code) ?? null;
}

/**
 * Remove a status. Refuses (false) when the row is a system row or any book
 * still carries the code — deleting would orphan those books' labels.
 */
export async function deleteBookStatus(
  db: BookStatusDb,
  code: number,
): Promise<boolean> {
  const existing = await db.prepare(
    "SELECT is_system FROM ext_book_status WHERE code = ?",
  ).bind(code).first();
  if (!existing) return false;
  if (flag(existing.is_system)) return false;
  const usage = await countChannelsByStatus(db);
  if ((usage.get(code) ?? 0) > 0) return false;
  await db.prepare("DELETE FROM ext_book_status WHERE code = ?").bind(code).run();
  return true;
}
