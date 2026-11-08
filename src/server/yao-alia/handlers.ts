/**
 * 独立「药材别名」模块（ADR-0064）的 handler 层。
 *
 * 与 `zhong-yao/handlers.ts` 同构：Zod 校验请求体，然后交给 `store.ts`（纯读写）。
 * 5 个 handler 对应后台 5 条 ajax 路由（看板/新建/更新/软删/物删）。无分组 →
 * 无 groups/reassign handler（左栏分组是 UI 只读派生，ADR-0064 决策 3）。无公共
 * api/v1、无 App 端点——模块只给后台用（ADR-0064 决策 8）。
 *
 * 校验真源在 `@/shared/YaoAlia`（UI 与 server 共用），这里只 import 不重写。
 * 与 App 别名读层零 import——两套模型并行共存。
 */

import {AppError} from "@/shared/errors";
import {randomShortUUID} from "@/shared/StringUtils";
import type {YaoAliaDb} from "./types";
import type {
  YaoAliaAdmin,
  YaoAliaBoard,
} from "@/shared/YaoAlia";
// 建表/编辑 schema 的唯一真源在 `@/shared/YaoAlia`（UI 与 server 共用），
// 这里只 import，不再本地重写——字段约束改一处即两侧生效。
import {
  yaoAliaCreateSchema,
  yaoAliaUpdateSchema,
} from "@/shared/YaoAlia";
import {
  createYaoAlia,
  loadYaoAliaBoard,
  purgeYaoAlia,
  softDeleteYaoAlia,
  updateYaoAlia,
} from "./store";

export const YAO_ALIA_ERRORS = {
  invalidInput: "errors.yaoAlia.invalidInput",
  notFound: "errors.yaoAlia.notFound",
  /** 物删只对已软删行开放：先软删，再物删（两步删除，破坏力差一个量级）。 */
  purgeNeedsDelete: "errors.yaoAlia.purgeNeedsDelete",
} as const;

/** 看板一次取齐：别名列表（`yao_alia`，含已软删行）。无分组、无来源书，比 ming-ci
 *  board 少两块——store 直接返回，handler 包一层 `YaoAliaBoard`（ADR-0064 决策 8
 *  「一次性返回」）。左栏分组由 UI 按 `yaoName` 派生，server 不返回 groups。 */
export async function listYaoAliaBoardHandler(
  db: YaoAliaDb,
): Promise<YaoAliaBoard> {
  return {entries: await loadYaoAliaBoard(db)};
}

export async function createYaoAliaHandler(
  db: YaoAliaDb,
  body: unknown,
): Promise<YaoAliaAdmin> {
  const parsed = yaoAliaCreateSchema.safeParse(body);
  if (!parsed.success) throw new AppError(YAO_ALIA_ERRORS.invalidInput, 400);
  // id 在这里生成（store 保持纯读写）。
  const id = randomShortUUID();
  return createYaoAlia(db, id, parsed.data);
}

export async function updateYaoAliaHandler(
  db: YaoAliaDb,
  id: string,
  body: unknown,
): Promise<YaoAliaAdmin> {
  if (!id) throw new AppError(YAO_ALIA_ERRORS.invalidInput, 400);
  const parsed = yaoAliaUpdateSchema.safeParse(body);
  if (!parsed.success) throw new AppError(YAO_ALIA_ERRORS.invalidInput, 400);
  if (Object.keys(parsed.data).length === 0) {
    throw new AppError(YAO_ALIA_ERRORS.invalidInput, 400);
  }
  const updated = await updateYaoAlia(db, id, parsed.data);
  if (!updated) throw new AppError(YAO_ALIA_ERRORS.notFound, 404);
  return updated;
}

export async function deleteYaoAliaHandler(
  db: YaoAliaDb,
  id: string,
): Promise<{deleted: true}> {
  if (!id) throw new AppError(YAO_ALIA_ERRORS.invalidInput, 400);
  const deleted = await softDeleteYaoAlia(db, id);
  if (!deleted) throw new AppError(YAO_ALIA_ERRORS.notFound, 404);
  return {deleted: true};
}

export async function purgeYaoAliaHandler(
  db: YaoAliaDb,
  id: string,
): Promise<{purged: true}> {
  if (!id) throw new AppError(YAO_ALIA_ERRORS.invalidInput, 400);
  const result = await purgeYaoAlia(db, id);
  if (!result.purged) {
    if (result.reason === "notDeleted") {
      throw new AppError(YAO_ALIA_ERRORS.purgeNeedsDelete, 409);
    }
    throw new AppError(YAO_ALIA_ERRORS.notFound, 404);
  }
  return {purged: true};
}
