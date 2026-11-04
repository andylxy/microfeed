/**
 * 独立「名词」模块（ADR-0060）的 handler 层。
 *
 * 与 `book-info/handlers.ts` 同构：Zod 校验请求体，然后交给 `store.ts`（纯读写）。
 * 7 个 handler 对应后台 7 条 ajax 路由（看板/分组读/分组写/改派/新建/更新/软删/物删，
 * 分组读写在 board 之外另立，与 book-info 同）。无公共 api/v1——模块只给后台用
 * （ADR-0060 决策 7）。
 *
 * 严格校验（审计定案，ADR-0060 决策 4）：
 * - `ming_ci_type` 必填且取值命中 `mingci_groups` 的 `key`，未命中 400；分组清单空
 *   → 拒新增 + 拒改（fail-closed，0 容错）。
 * - 删组前 COUNT>0 拒删（须先 reassign），或强制改派——save 分组时逐组核对。
 */

import {z} from "zod";

import {AppError} from "@/shared/errors";
import {randomShortUUID} from "@/shared/StringUtils";
import type {MingCiDb} from "./types";
import type {
  MingCiAdmin,
  MingCiBoard,
  MingCiGroup,
  MingCiSourceBook,
} from "@/shared/MingCi";
// 建表/编辑 schema 的唯一真源在 `@/shared/MingCi`（UI 与 server 共用），
// 这里只 import，不再本地重写——字段约束改一处即两侧生效。
import {
  mingCiCreateSchema,
  mingCiUpdateSchema,
} from "@/shared/MingCi";
import {
  countMingCiByType,
  createMingCi,
  loadMingCiBoard,
  purgeMingCi,
  reassignMingCiType,
  softDeleteMingCi,
  updateMingCi,
} from "./store";
import {
  loadMingCiGroups,
  mingCiGroupsSchema,
  saveMingCiGroups,
} from "./groups";

/** 改派载荷：`from`/`to` 都是非空分组键，且不能相同（自己改派给自己无意义）。 */
const reassignGroupSchema = z.object({
  from: z.string().trim().min(1),
  to: z.string().trim().min(1),
}).refine((value) => value.from !== value.to, {message: "same_group"});

export const MING_CI_ERRORS = {
  invalidInput: "errors.mingCi.invalidInput",
  notFound: "errors.mingCi.notFound",
  purgeNeedsDelete: "errors.mingCi.purgeNeedsDelete",
  /** 最后一个分组不可删：`ming_ci_type` NOT NULL，删了无处改派（ADR-0060 决策 4）。 */
  lastGroup: "errors.mingCi.lastGroup",
  /** 被删分组仍有在册名词：须先 reassign（审计约束，删组前 COUNT>0 拒删）。 */
  groupHasNouns: "errors.mingCi.groupHasNouns",
  /** `ming_ci_type` 不在分组清单内 / 分组清单空：严格校验命中 key（fail-closed）。 */
  invalidType: "errors.mingCi.invalidType",
  /** 改派目标/来源不在当前分组清单内：防止改派到不存在分组产生游离类。 */
  invalidGroup: "errors.mingCi.invalidGroup",
} as const;

/** 校验 `ming_ci_type` 是分组清单内的取值（fail-closed：空清单 → 任何取值都拒）。 */
function assertMingCiTypeInGroups(type: string, groups: MingCiGroup[]): void {
  if (!groups.some((group) => group.key === type)) {
    throw new AppError(MING_CI_ERRORS.invalidType, 400);
  }
}

/** 来源书下拉（从 `book_info` 加载，供 `source_book_id` 选择；含已软删？否，
 *  下拉只给可用书）。来源引用是宽松校验（可空/悬空回落），此处只做加载。 */
async function loadMingCiSourceBooks(
  db: D1Database,
): Promise<MingCiSourceBook[]> {
  const result = await db.prepare(
    "SELECT id, book_name, book_no FROM book_info " +
      "WHERE deleted_at IS NULL ORDER BY book_name ASC, id ASC",
  ).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  return rows.map((row) => ({
    id: String(row.id ?? ""),
    bookName: String(row.book_name ?? ""),
    bookNo: String(row.book_no ?? ""),
  }));
}

/** 看板一次取齐：分组（settings）+ 来源书（`book_info`）+ 名词（`ming_ci`）。
 *  两侧 db 在调用方是同一个 `env.FEED_DB`，但分组走 settings 通道、来源书与
 *  名词走各自端口，故分开接（ADR-0060 决策 7「一次性返回」）。 */
export async function listMingCiBoardHandler(
  db: MingCiDb,
  groupsDb: D1Database,
): Promise<MingCiBoard> {
  const [groups, sourceBooks, nouns] = await Promise.all([
    loadMingCiGroups(groupsDb),
    loadMingCiSourceBooks(groupsDb),
    loadMingCiBoard(db),
  ]);
  return {groups, sourceBooks, nouns};
}

/** 分组清单（settings）。 */
export async function listMingCiGroupsHandler(
  groupsDb: D1Database,
): Promise<MingCiGroup[]> {
  return loadMingCiGroups(groupsDb);
}

/** 整表覆盖写分组清单。空清单 = 删掉最后一个分组 → 400（`ming_ci_type` NOT NULL，
 *  删了无处改派）。**逐组核对**：新清单里被移除的组，若仍有在册名词（COUNT>0）
 *  → 400（须先 reassign），防游离分类。 */
export async function saveMingCiGroupsHandler(
  db: MingCiDb,
  groupsDb: D1Database,
  body: unknown,
): Promise<{groups: MingCiGroup[]}> {
  const parsed = mingCiGroupsSchema.safeParse(body);
  if (!parsed.success) throw new AppError(MING_CI_ERRORS.invalidInput, 400);
  if (parsed.data.groups.length === 0) {
    throw new AppError(MING_CI_ERRORS.lastGroup, 400);
  }
  const current = await loadMingCiGroups(groupsDb);
  const newKeys = new Set(parsed.data.groups.map((group) => group.key));
  for (const group of current) {
    if (newKeys.has(group.key)) continue;
    const count = await countMingCiByType(db, group.key);
    if (count > 0) throw new AppError(MING_CI_ERRORS.groupHasNouns, 409);
  }
  await saveMingCiGroups(groupsDb, parsed.data.groups);
  return {groups: parsed.data.groups};
}

/** 改派：把 `from` 组的整批名词挪到 `to` 组（删组前先改派，ADR-0060 决策 4）。
 *  `from`/`to` 都须在当前分组清单内（防改派到不存在分组产生游离类）。 */
export async function reassignMingCiGroupHandler(
  db: MingCiDb,
  groupsDb: D1Database,
  body: unknown,
): Promise<{reassigned: true}> {
  const parsed = reassignGroupSchema.safeParse(body);
  if (!parsed.success) throw new AppError(MING_CI_ERRORS.invalidInput, 400);
  const groups = await loadMingCiGroups(groupsDb);
  const keys = new Set(groups.map((group) => group.key));
  if (!keys.has(parsed.data.from) || !keys.has(parsed.data.to)) {
    throw new AppError(MING_CI_ERRORS.invalidGroup, 400);
  }
  await reassignMingCiType(db, parsed.data.from, parsed.data.to);
  return {reassigned: true};
}

export async function createMingCiHandler(
  db: MingCiDb,
  groupsDb: D1Database,
  body: unknown,
): Promise<MingCiAdmin> {
  const parsed = mingCiCreateSchema.safeParse(body);
  if (!parsed.success) throw new AppError(MING_CI_ERRORS.invalidInput, 400);
  // id 在这里生成（store 保持纯读写）。
  const id = randomShortUUID();
  assertMingCiTypeInGroups(parsed.data.mingCiType, await loadMingCiGroups(groupsDb));
  return createMingCi(db, id, parsed.data);
}

export async function updateMingCiHandler(
  db: MingCiDb,
  groupsDb: D1Database,
  id: string,
  body: unknown,
): Promise<MingCiAdmin> {
  if (!id) throw new AppError(MING_CI_ERRORS.invalidInput, 400);
  const parsed = mingCiUpdateSchema.safeParse(body);
  if (!parsed.success) throw new AppError(MING_CI_ERRORS.invalidInput, 400);
  if (Object.keys(parsed.data).length === 0) {
    throw new AppError(MING_CI_ERRORS.invalidInput, 400);
  }
  if (parsed.data.mingCiType !== undefined) {
    assertMingCiTypeInGroups(parsed.data.mingCiType, await loadMingCiGroups(groupsDb));
  }
  const updated = await updateMingCi(db, id, parsed.data);
  if (!updated) throw new AppError(MING_CI_ERRORS.notFound, 404);
  return updated;
}

export async function deleteMingCiHandler(
  db: MingCiDb,
  id: string,
): Promise<{deleted: true}> {
  if (!id) throw new AppError(MING_CI_ERRORS.invalidInput, 400);
  const deleted = await softDeleteMingCi(db, id);
  if (!deleted) throw new AppError(MING_CI_ERRORS.notFound, 404);
  return {deleted: true};
}

export async function purgeMingCiHandler(
  db: MingCiDb,
  id: string,
): Promise<{purged: true}> {
  if (!id) throw new AppError(MING_CI_ERRORS.invalidInput, 400);
  const result = await purgeMingCi(db, id);
  if (!result.purged) {
    if (result.reason === "notDeleted") {
      throw new AppError(MING_CI_ERRORS.purgeNeedsDelete, 409);
    }
    throw new AppError(MING_CI_ERRORS.notFound, 404);
  }
  return {purged: true};
}
