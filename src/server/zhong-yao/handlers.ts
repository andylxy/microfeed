/**
 * 独立「本草」模块（ADR-0061）的 handler 层。
 *
 * 与 `ming-ci/handlers.ts` 同构：Zod 校验请求体，然后交给 `store.ts`（纯读写）。
 * 5 个 handler 对应后台 5 条 ajax 路由（看板/新建/更新/软删/物删）。无分组 →
 * 无 groups/reassign handler（比 ming-ci 瘦，ADR-0061 决策 3）。无公共 api/v1、
 * 无 App 端点——模块只给后台用（ADR-0061 决策 8）。
 *
 * 校验真源在 `@/shared/ZhongYao`（UI 与 server 共用），这里只 import 不重写。
 */

import {AppError} from "@/shared/errors";
import {randomShortUUID} from "@/shared/StringUtils";
import type {ZhongYaoDb} from "./types";
import type {
  ZhongYaoAdmin,
  ZhongYaoBoard,
} from "@/shared/ZhongYao";
// 建表/编辑 schema 的唯一真源在 `@/shared/ZhongYao`（UI 与 server 共用），
// 这里只 import，不再本地重写——字段约束改一处即两侧生效。
import {
  zhongYaoCreateSchema,
  zhongYaoUpdateSchema,
} from "@/shared/ZhongYao";
import {
  createZhongYao,
  loadZhongYaoBoard,
  purgeZhongYao,
  softDeleteZhongYao,
  updateZhongYao,
} from "./store";

export const ZHONG_YAO_ERRORS = {
  invalidInput: "errors.zhongYao.invalidInput",
  notFound: "errors.zhongYao.notFound",
  /** 物删只对已软删行开放：先软删，再物删（两步删除，破坏力差一个量级）。 */
  purgeNeedsDelete: "errors.zhongYao.purgeNeedsDelete",
} as const;

/** 看板一次取齐：本草列表（`zhong_yao`）。无分组、无来源书，比 ming-ci board
 *  少两块——store 直接返回，handler 包一层 `ZhongYaoBoard`（ADR-0061 决策 8
 *  「一次性返回」）。 */
export async function listZhongYaoBoardHandler(
  db: ZhongYaoDb,
): Promise<ZhongYaoBoard> {
  return {entries: await loadZhongYaoBoard(db)};
}

export async function createZhongYaoHandler(
  db: ZhongYaoDb,
  body: unknown,
): Promise<ZhongYaoAdmin> {
  const parsed = zhongYaoCreateSchema.safeParse(body);
  if (!parsed.success) throw new AppError(ZHONG_YAO_ERRORS.invalidInput, 400);
  // id 在这里生成（store 保持纯读写）。
  const id = randomShortUUID();
  return createZhongYao(db, id, parsed.data);
}

export async function updateZhongYaoHandler(
  db: ZhongYaoDb,
  id: string,
  body: unknown,
): Promise<ZhongYaoAdmin> {
  if (!id) throw new AppError(ZHONG_YAO_ERRORS.invalidInput, 400);
  const parsed = zhongYaoUpdateSchema.safeParse(body);
  if (!parsed.success) throw new AppError(ZHONG_YAO_ERRORS.invalidInput, 400);
  if (Object.keys(parsed.data).length === 0) {
    throw new AppError(ZHONG_YAO_ERRORS.invalidInput, 400);
  }
  const updated = await updateZhongYao(db, id, parsed.data);
  if (!updated) throw new AppError(ZHONG_YAO_ERRORS.notFound, 404);
  return updated;
}

export async function deleteZhongYaoHandler(
  db: ZhongYaoDb,
  id: string,
): Promise<{deleted: true}> {
  if (!id) throw new AppError(ZHONG_YAO_ERRORS.invalidInput, 400);
  const deleted = await softDeleteZhongYao(db, id);
  if (!deleted) throw new AppError(ZHONG_YAO_ERRORS.notFound, 404);
  return {deleted: true};
}

export async function purgeZhongYaoHandler(
  db: ZhongYaoDb,
  id: string,
): Promise<{purged: true}> {
  if (!id) throw new AppError(ZHONG_YAO_ERRORS.invalidInput, 400);
  const result = await purgeZhongYao(db, id);
  if (!result.purged) {
    if (result.reason === "notDeleted") {
      throw new AppError(ZHONG_YAO_ERRORS.purgeNeedsDelete, 409);
    }
    throw new AppError(ZHONG_YAO_ERRORS.notFound, 404);
  }
  return {purged: true};
}
