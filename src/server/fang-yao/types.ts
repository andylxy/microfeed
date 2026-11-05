/**
 * 独立「方剂」模块（ADR-0065）的服务端类型与 D1 端口。
 *
 * 端口镜像 `book-chapter/types.ts` / `ming-ci/types.ts` 的形态：只暴露
 * `prepare`，让 unit 测试用假实现注入，不绑定真 D1。看板形状见
 * `@/shared/FangYao`；两表原始行（snake_case）由 store 层以
 * `Record<string, unknown>` 读入后经 `rowToAdmin`/`rowToBodyAdmin` 投影，
 * 无独立行类型（避免只写不读的死导出）。
 */

import type {
  FangYaoAdmin,
  FangYaoBodyAdmin,
  FangYaoBodyInput,
  FangYaoBoard,
  FangYaoInput,
  FangYaoSourceGroup,
} from "@/shared/FangYao";

export type {
  FangYaoAdmin,
  FangYaoBodyAdmin,
  FangYaoBodyInput,
  FangYaoBoard,
  FangYaoInput,
  FangYaoSourceGroup,
};

/** 极简 D1 形状的数据库端口；unit 测试用假实现注入。
 *  与 `MingCiDb` / `BookInfoDb` / `BookChapterDb` 同款。 */
export interface FangYaoDbRunResult {
  success: boolean;
}

export interface FangYaoDbAllResult {
  results: Record<string, unknown>[];
}

export interface FangYaoDbPreparedStatement {
  bind(...values: unknown[]): FangYaoDbPreparedStatement;
  run(): Promise<FangYaoDbRunResult>;
  all(): Promise<FangYaoDbAllResult>;
  first(): Promise<Record<string, unknown> | null>;
}

export interface FangYaoDb {
  prepare(query: string): FangYaoDbPreparedStatement;
}
