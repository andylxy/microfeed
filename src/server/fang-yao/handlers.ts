/**
 * 独立「方剂」模块（ADR-0065）的 handler 层。
 *
 * 与 `book-chapter/handlers.ts` 同构：Zod 校验请求体，然后交给 `store.ts`
 * （纯读写）。无公共 api/v1——模块只给后台用（ADR-0065 决策 9，不进
 * OpenAPI、不在 exempt 名单）。
 *
 * 严格校验只有一条硬约束：`fangName` / `fangText` 非空。文本字段**一律不
 * trim**（ADR-0065 决策 4）——方文的前导缩进、句号后空格、换行、制表符都
 * 是内容，校验只做长度与非空判定，绝不改写值。
 *
 * 看板左栏「源书 → 方」两层树的组聚合在这里派生（store 只管 `fang_yao`）：
 * 按 `source_book_legacy_id` 分组，组名 `source_book_name` 兜底，计数只数
 * 未软删方。**不联动 `book_info`**（方剂书不一定在 book_info 里，ADR-0065
 * 决策 5），故本 handler 签名只要 `db`，无 `sourceDb`。
 */

import {AppError} from "@/shared/errors";
import {randomShortUUID} from "@/shared/StringUtils";
import type {FangYaoDb} from "./types";
import type {
  FangYaoAdmin,
  FangYaoBoard,
  FangYaoBodyAdmin,
  FangYaoSourceGroup,
} from "@/shared/FangYao";
// 建表/编辑 schema 的唯一真源在 `@/shared/FangYao`（UI 与 server 共用），
// 这里只 import，不再本地重写——字段约束改一处即两侧生效。
import {
  fangYaoBodyCreateSchema,
  fangYaoBodyUpdateSchema,
  fangYaoCreateSchema,
  fangYaoUpdateSchema,
  UNGROUPED_KEY,
} from "@/shared/FangYao";
import {
  createFangYao,
  createFangYaoBody,
  getFangYao,
  getFangYaoBody,
  listBodiesByFang,
  loadFangYaoBoard,
  purgeFangYao,
  purgeFangYaoBody,
  softDeleteFangYao,
  softDeleteFangYaoBody,
  updateFangYao,
  updateFangYaoBody,
} from "./store";

export const FANG_YAO_ERRORS = {
  invalidInput: "errors.fangYao.invalidInput",
  notFound: "errors.fangYao.notFound",
  purgeNeedsDelete: "errors.fangYao.purgeNeedsDelete",
  purgeHasBodies: "errors.fangYao.purgeHasBodies",
} as const;

/** 未归属源书组的兜底桶：`source_book_legacy_id` 为空时方剂在左栏没有组可挂，
 *  不并入此桶就会被静默丢弃。生产数据 5 组均有 legacy id，此桶预期空。
 *  哨兵键来自 shared 单一真源 `UNGROUPED_KEY`（与后台 UI 同源，防漂移）。 */

/** 把方剂目录聚合成左栏两层树的顶层组（源书）。
 *  组名 `source_book_name` 兜底，缺名时回退 legacy id，再缺归「未归属源书组」。
 *  计数只数未软删方（看板总览与各级徽章同口径）。 */
function buildSourceGroups(formulas: FangYaoAdmin[]): FangYaoSourceGroup[] {
  const byGroup = new Map<string, FangYaoSourceGroup>();
  for (const formula of formulas) {
    if (formula.isDeleted) continue;
    const key = formula.sourceBookLegacyId || UNGROUPED_KEY;
    const name = formula.sourceBookName
      || formula.sourceBookLegacyId
      || "未归属源书组";
    const existing = byGroup.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      byGroup.set(key, {key, name, count: 1});
    }
  }
  return [...byGroup.values()].sort(
    (a, b) => b.count - a.count || a.key.localeCompare(b.key),
  );
}

/** 看板一次取齐：源书分组（按 `fang_yao.source_book_legacy_id` 聚合）
 *  + 方剂目录。两者都是只读派生，供左栏拼「源书 → 方」两层导航。
 *  组成不在看板里（2025 行偏重），选中某方后走 bodies 端点取。 */
export async function listFangYaoBoardHandler(
  db: FangYaoDb,
): Promise<FangYaoBoard> {
  const formulas = await loadFangYaoBoard(db);
  return {groups: buildSourceGroups(formulas), formulas};
}

export async function createFangYaoHandler(
  db: FangYaoDb,
  body: unknown,
): Promise<FangYaoAdmin> {
  const parsed = fangYaoCreateSchema.safeParse(body);
  if (!parsed.success) throw new AppError(FANG_YAO_ERRORS.invalidInput, 400);
  // id 在这里生成（store 保持纯读写）。
  const id = randomShortUUID();
  return createFangYao(db, id, parsed.data);
}

export async function updateFangYaoHandler(
  db: FangYaoDb,
  id: string,
  body: unknown,
): Promise<FangYaoAdmin> {
  if (!id) throw new AppError(FANG_YAO_ERRORS.invalidInput, 400);
  const parsed = fangYaoUpdateSchema.safeParse(body);
  if (!parsed.success) throw new AppError(FANG_YAO_ERRORS.invalidInput, 400);
  if (Object.keys(parsed.data).length === 0) {
    throw new AppError(FANG_YAO_ERRORS.invalidInput, 400);
  }
  const updated = await updateFangYao(db, id, parsed.data);
  if (!updated) throw new AppError(FANG_YAO_ERRORS.notFound, 404);
  return updated;
}

export async function getFangYaoHandler(
  db: FangYaoDb,
  id: string,
): Promise<FangYaoAdmin> {
  if (!id) throw new AppError(FANG_YAO_ERRORS.invalidInput, 400);
  const formula = await getFangYao(db, id);
  if (!formula) throw new AppError(FANG_YAO_ERRORS.notFound, 404);
  return formula;
}

export async function deleteFangYaoHandler(
  db: FangYaoDb,
  id: string,
): Promise<{deleted: true}> {
  if (!id) throw new AppError(FANG_YAO_ERRORS.invalidInput, 400);
  const deleted = await softDeleteFangYao(db, id);
  if (!deleted) throw new AppError(FANG_YAO_ERRORS.notFound, 404);
  return {deleted: true};
}

export async function purgeFangYaoHandler(
  db: FangYaoDb,
  id: string,
): Promise<{purged: true}> {
  if (!id) throw new AppError(FANG_YAO_ERRORS.invalidInput, 400);
  const result = await purgeFangYao(db, id);
  if (!result.purged) {
    if (result.reason === "notDeleted") {
      throw new AppError(FANG_YAO_ERRORS.purgeNeedsDelete, 409);
    }
    if (result.reason === "hasBodies") {
      throw new AppError(FANG_YAO_ERRORS.purgeHasBodies, 409);
    }
    throw new AppError(FANG_YAO_ERRORS.notFound, 404);
  }
  return {purged: true};
}

/** 某方剂下的组成列表（含已软删，`isDeleted` 区分）。 */
export async function listFangYaoBodiesHandler(
  db: FangYaoDb,
  fangId: string,
): Promise<{bodies: FangYaoBodyAdmin[]}> {
  if (!fangId) throw new AppError(FANG_YAO_ERRORS.invalidInput, 400);
  return {bodies: await listBodiesByFang(db, fangId)};
}

export async function createFangYaoBodyHandler(
  db: FangYaoDb,
  fangId: string,
  body: unknown,
): Promise<FangYaoBodyAdmin> {
  if (!fangId) throw new AppError(FANG_YAO_ERRORS.invalidInput, 400);
  const parsed = fangYaoBodyCreateSchema.safeParse(body);
  if (!parsed.success) throw new AppError(FANG_YAO_ERRORS.invalidInput, 400);
  const id = randomShortUUID();
  return createFangYaoBody(db, id, fangId, parsed.data);
}

export async function updateFangYaoBodyHandler(
  db: FangYaoDb,
  bodyId: string,
  body: unknown,
): Promise<FangYaoBodyAdmin> {
  if (!bodyId) throw new AppError(FANG_YAO_ERRORS.invalidInput, 400);
  const parsed = fangYaoBodyUpdateSchema.safeParse(body);
  if (!parsed.success) throw new AppError(FANG_YAO_ERRORS.invalidInput, 400);
  if (Object.keys(parsed.data).length === 0) {
    throw new AppError(FANG_YAO_ERRORS.invalidInput, 400);
  }
  const updated = await updateFangYaoBody(db, bodyId, parsed.data);
  if (!updated) throw new AppError(FANG_YAO_ERRORS.notFound, 404);
  return updated;
}

export async function getFangYaoBodyHandler(
  db: FangYaoDb,
  bodyId: string,
): Promise<FangYaoBodyAdmin> {
  if (!bodyId) throw new AppError(FANG_YAO_ERRORS.invalidInput, 400);
  const body = await getFangYaoBody(db, bodyId);
  if (!body) throw new AppError(FANG_YAO_ERRORS.notFound, 404);
  return body;
}

export async function deleteFangYaoBodyHandler(
  db: FangYaoDb,
  bodyId: string,
): Promise<{deleted: true}> {
  if (!bodyId) throw new AppError(FANG_YAO_ERRORS.invalidInput, 400);
  const deleted = await softDeleteFangYaoBody(db, bodyId);
  if (!deleted) throw new AppError(FANG_YAO_ERRORS.notFound, 404);
  return {deleted: true};
}

export async function purgeFangYaoBodyHandler(
  db: FangYaoDb,
  bodyId: string,
): Promise<{purged: true}> {
  if (!bodyId) throw new AppError(FANG_YAO_ERRORS.invalidInput, 400);
  const result = await purgeFangYaoBody(db, bodyId);
  if (!result.purged) {
    if (result.reason === "notDeleted") {
      throw new AppError(FANG_YAO_ERRORS.purgeNeedsDelete, 409);
    }
    throw new AppError(FANG_YAO_ERRORS.notFound, 404);
  }
  return {purged: true};
}
