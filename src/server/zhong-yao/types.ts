/**
 * 独立「本草」模块（ADR-0061）的服务端类型与 D1 端口。
 *
 * 端口镜像 `MingCiDb`（ADR-0060）/ `BookDb` 的形态：只暴露 `prepare`，让 unit
 * 测试用假实现注入，不绑定真 D1。看板形状 `ZhongYaoAdmin` 见 `@/shared/ZhongYao`；
 * `zhong_yao` 原始行（snake_case）由 store 层以 `Record<string, unknown>` 读入后
 * 经 `rowToAdmin` 投影，无独立行类型（避免只写不读的死导出）。
 */

import type {
  ZhongYaoAdmin,
  ZhongYaoBoard,
  ZhongYaoInput,
} from "@/shared/ZhongYao";

export type {
  ZhongYaoAdmin,
  ZhongYaoBoard,
  ZhongYaoInput,
};

/** 极简 D1 形状的数据库端口；unit 测试用假实现注入。
 *  与 `MingCiDb` / `BookInfoDb` / `BookDb` / `VolumeDb` 同款。 */
export interface ZhongYaoDbRunResult {
  success: boolean;
}

export interface ZhongYaoDbAllResult {
  results: Record<string, unknown>[];
}

export interface ZhongYaoDbPreparedStatement {
  bind(...values: unknown[]): ZhongYaoDbPreparedStatement;
  run(): Promise<ZhongYaoDbRunResult>;
  all(): Promise<ZhongYaoDbAllResult>;
  first(): Promise<Record<string, unknown> | null>;
}

export interface ZhongYaoDb {
  prepare(query: string): ZhongYaoDbPreparedStatement;
}
