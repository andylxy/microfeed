/**
 * 独立「书本卷章」模块（ADR-0062）的服务端类型与 D1 端口。
 *
 * 端口镜像 `ming-ci/types.ts` 的形态：只暴露 `prepare`，让 unit 测试用假实现
 * 注入，不绑定真 D1。看板形状见 `@/shared/BookChapter`；两表原始行
 * （snake_case）由 store 层以 `Record<string, unknown>` 读入后经
 * `rowToAdmin`/`rowToBodyAdmin` 投影，无独立行类型（避免只写不读的死导出）。
 */

import type {
  BookChapterAdmin,
  BookChapterBoard,
  BookChapterBodyAdmin,
  BookChapterBodyInput,
  BookChapterInput,
  BookChapterSourceBook,
} from "@/shared/BookChapter";

export type {
  BookChapterAdmin,
  BookChapterBoard,
  BookChapterBodyAdmin,
  BookChapterBodyInput,
  BookChapterInput,
  BookChapterSourceBook,
};

/** 极简 D1 形状的数据库端口；unit 测试用假实现注入。
 *  与 `MingCiDb` / `BookInfoDb` / `BookDb` 同款。 */
export interface BookChapterDbRunResult {
  success: boolean;
}

export interface BookChapterDbAllResult {
  results: Record<string, unknown>[];
}

export interface BookChapterDbPreparedStatement {
  bind(...values: unknown[]): BookChapterDbPreparedStatement;
  run(): Promise<BookChapterDbRunResult>;
  all(): Promise<BookChapterDbAllResult>;
  first(): Promise<Record<string, unknown> | null>;
}

export interface BookChapterDb {
  prepare(query: string): BookChapterDbPreparedStatement;
}
