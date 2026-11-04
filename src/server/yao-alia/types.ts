/**
 * 独立「药材别名」模块（ADR-0064）的服务端类型与 D1 端口。
 *
 * 端口镜像 `ZhongYaoDb`（ADR-0061）/ `MingCiDb`（ADR-0060）/ `BookDb` 的形态：
 * 只暴露 `prepare`，让 unit 测试用假实现注入，不绑定真 D1。看板形状 `YaoAliaAdmin`
 * 见 `@/shared/YaoAlia`；`yao_alia` 原始行（snake_case）由 store 层以
 * `Record<string, unknown>` 读入后经 `rowToAdmin` 投影，无独立行类型
 * （避免只写不读的死导出）。
 */

import type {
  YaoAliaAdmin,
  YaoAliaBoard,
  YaoAliaInput,
} from "@/shared/YaoAlia";

export type {
  YaoAliaAdmin,
  YaoAliaBoard,
  YaoAliaInput,
};

/** 极简 D1 形状的数据库端口；unit 测试用假实现注入。
 *  与 `ZhongYaoDb` / `MingCiDb` / `BookInfoDb` / `BookDb` 同款。 */
export interface YaoAliaDbRunResult {
  success: boolean;
}

export interface YaoAliaDbAllResult {
  results: Record<string, unknown>[];
}

export interface YaoAliaDbPreparedStatement {
  bind(...values: unknown[]): YaoAliaDbPreparedStatement;
  run(): Promise<YaoAliaDbRunResult>;
  all(): Promise<YaoAliaDbAllResult>;
  first(): Promise<Record<string, unknown> | null>;
}

export interface YaoAliaDb {
  prepare(query: string): YaoAliaDbPreparedStatement;
}
