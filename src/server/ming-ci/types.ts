/**
 * 独立「名词」模块（ADR-0060）的服务端类型与 D1 端口。
 *
 * 端口镜像 `feed/extBook.ts` 的 `BookDb` 形态：只暴露 `prepare`，让 unit 测试
 * 用假实现注入，不绑定真 D1。看板形状 `MingCiAdmin` 见 `@/shared/MingCi`；
 * `ming_ci` 原始行（snake_case）由 store 层以 `Record<string, unknown>` 读入后
 * 经 `rowToAdmin` 投影，无独立行类型（避免只写不读的死导出）。
 */

import type {
  MingCiAdmin,
  MingCiBoard,
  MingCiGroup,
  MingCiInput,
} from "@/shared/MingCi";

export type {
  MingCiAdmin,
  MingCiBoard,
  MingCiGroup,
  MingCiInput,
};

/** 极简 D1 形状的数据库端口；unit 测试用假实现注入。
 *  与 `BookInfoDb` / `BookDb` / `CategoryDb` / `VolumeDb` 同款。 */
export interface MingCiDbRunResult {
  success: boolean;
}

export interface MingCiDbAllResult {
  results: Record<string, unknown>[];
}

export interface MingCiDbPreparedStatement {
  bind(...values: unknown[]): MingCiDbPreparedStatement;
  run(): Promise<MingCiDbRunResult>;
  all(): Promise<MingCiDbAllResult>;
  first(): Promise<Record<string, unknown> | null>;
}

export interface MingCiDb {
  prepare(query: string): MingCiDbPreparedStatement;
}
