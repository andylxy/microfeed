/**
 * 独立「书本信息」模块（ADR-0058）的服务端类型与 D1 端口。
 *
 * 端口镜像 `feed/extBook.ts` 的 `BookDb` 形态：只暴露 `prepare`，让 unit 测试
 * 用假实现注入，不绑定真 D1。`BookInfoRow` 是 `book_info` 表的原始行
 * （snake_case），`BookInfoAdmin` 看板形状见 `@/shared/BookInfo`。
 */

import type {
  BookInfoAdmin,
  BookInfoBoard,
  BookInfoInput,
  BookInfoStatus,
} from "@/shared/BookInfo";

export type {
  BookInfoAdmin,
  BookInfoBoard,
  BookInfoInput,
  BookInfoStatus,
};

/** 极简 D1 形状的数据库端口；unit 测试用假实现注入。
 *  与 `BookDb` / `CategoryDb` / `VolumeDb` 同款。 */
export interface BookInfoDbRunResult {
  success: boolean;
}

export interface BookInfoDbAllResult {
  results: Record<string, unknown>[];
}

export interface BookInfoDbPreparedStatement {
  bind(...values: unknown[]): BookInfoDbPreparedStatement;
  run(): Promise<BookInfoDbRunResult>;
  all(): Promise<BookInfoDbAllResult>;
  first(): Promise<Record<string, unknown> | null>;
}

export interface BookInfoDb {
  prepare(query: string): BookInfoDbPreparedStatement;
}

/** 一列 `book_info` 原始行（snake_case，迁移 0171 + 0173）。 */
export interface BookInfoRow {
  id: string;
  book_name: string;
  chapter: number | null;
  author: string | null;
  cheng_shu: string | null;
  case_division: string;
  case_tag: string;
  book_no: string;
  image_url: string | null;
  hot_book: number;
  parent_id: string | null;
  org_id: number | null;
  is_enable: number;
  comment: string | null;
  created_at: string | null;
  updated_at: string | null;
  deleted_at: string | null;
}
