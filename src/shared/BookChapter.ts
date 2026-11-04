/**
 * 独立「书本卷章」模块（ADR-0062）的 shared 类型 + Zod 真源。
 *
 * 两张与 `items`/`channels` **完全解耦**的独立表（迁移 0181/0182）：
 * - `book_chapter` = 445 行卷章目录（源自 `ctwh/BookChapter.sql`）
 * - `book_chapter_body` = 8066 行卷章正文（源自 `ctwh/BookChapterBody.sql`，
 *   由 `scripts/import-ctwh/import-chapter-body.mjs` 导入）
 *
 * 放在 `shared` 而非 `server/book-chapter/`，是因为后台 UI 与 server 要用同一
 * 形状给 AJAX 载荷定型——字段加在这里会同时在两侧报编译错，防载荷悄悄不匹配。
 * `handlers.ts` 只 import 这里的 schema，不再本地重写。
 *
 * ## 格式保真（ADR-0062 决策 6，执行期铁律）
 *
 * **所有文本字段一律不 `.trim()`**。源正文的格式远比本草/名词丰富：
 * 前导缩进、句号后空格、真实换行、字面 CR——这些都是内容，不是噪声。
 * 校验只做长度与非空，绝不改写值。UI 也必须原样提交。
 */

import {z} from "zod";

import type {BookInfoGroup} from "@/shared/BookInfo";

/**
 * 非空文本：长度 ≥ 1 且 trim 后仍有可见字符。
 *
 * `refine` 只用于拒绝「全空白」这种无意义输入，**不修改值**——前后空格、
 * 换行、制表符原样保留（源 ChapterHeader 有 6 行前导空格）。
 */
const nonEmptyPreservingText = (max?: number) => {
  const base = max === undefined ? z.string().min(1) : z.string().min(1).max(max);
  return base.refine((value) => value.trim() !== "", {message: "blank_text"});
};

/** 一列 `book_chapter` 行在后台看板上的视图（camelCase）。
 *  `isDeleted` 由 `deleted_at` 派生，供两步删除流程区分「编辑/软删」与「物删」。 */
export interface BookChapterAdmin {
  id: string;
  /** 显示/排序序号（唯一；新建走 MAX+1）。绝不复用源 ChapterSection。 */
  chapterNo: number;
  /** ChapterHeader 章节标题（必填；含 `$a{}/$r{}` 标记原样存储不解析） */
  chapterHeader: string;
  /** → `book_info.id`（逻辑引用，无硬外键；下拉选书） */
  sourceBookId: string | null;
  /** 源 BookName 只读历史（153/445 NULL，缺失时 UI 用 book_info 书名兜底） */
  sourceBookName: string | null;
  /** 源 BookId 只读历史（如 10001），可追溯 */
  sourceBookLegacyId: string | null;
  /** 源 ChapterSection 保真（跨书异构，**仅追溯，不参与排序**） */
  chapterSection: string | null;
  /** 源 IsEnable（343=1 / 102=0；导入全量含禁用） */
  isEnable: boolean;
  /** 源 SignatureId（列位保留，admin 不编辑） */
  signatureId: string | null;
  /** 源 Signature（列位保留，admin 不编辑，不作 ETag） */
  signature: string | null;
  /** True = 已软删（`deleted_at` 非空），看板只对这类行提供物删。 */
  isDeleted: boolean;
}

/** 一列 `book_chapter_body` 行的视图（camelCase）。 */
export interface BookChapterBodyAdmin {
  id: string;
  /** → `book_chapter.id`（逻辑引用；审计 100% 非空、0 悬空） */
  bookChapterId: string;
  /** 源 ReceiptNo（卷章内唯一有序，正文排序键） */
  receiptNo: number;
  /** SectionText 正文（必填；`$a{}/$m{}/$n{}/$x{}` 标记原样存储不解析） */
  sectionText: string;
  /** SectionNote 注释（可空；17.7% 非空） */
  sectionNote: string | null;
  /** FangJi 方剂原文（逗号分隔多值；导入时空串→NULL 归一） */
  fangJi: string | null;
  /** FangJiZhujie 方剂注解（可空） */
  fangJiZhujie: string | null;
  /** BieMing 本草「药名+别名」原文（930 行非空，逗号分隔，首段=药名） */
  bieMing: string | null;
  /** 本草药名联结键 = `bie_ming` 首逗号段（**导入派生、只读**；仅 930 行非空） */
  bencaoYaoName: string | null;
  /** 本草等级 = 源 Extend01（`'0'`=545 / `'1'`=385；**导入派生、只读**） */
  bencaoLevel: string | null;
  /** 源 IsEnable（930=1 / 7136=0）。判别「是否本草条目」看 `bencaoYaoName`，不看本列。 */
  isEnable: boolean;
  /** 源 SignatureId（列位保留，admin 不编辑） */
  signatureId: string | null;
  /** 源 Signature（列位保留） */
  signature: string | null;
  /** True = 已软删。 */
  isDeleted: boolean;
}

/** 新建/编辑卷章的载荷。可空字段用 `| null` 表示「显式清空」，`undefined`
 *  表示「不改」。`chapterNo` 不由客户端给（store 走 MAX+1）。 */
export interface BookChapterInput {
  chapterHeader: string;
  sourceBookId?: string | null;
  sourceBookName?: string | null;
  chapterSection?: string | null;
  isEnable?: boolean;
}

/** 新建/编辑正文的载荷。`receiptNo` 缺省时 store 取卷章内 `MAX+1`。
 *  `bencaoYaoName`/`bencaoLevel` **不在载荷里**——它们是导入派生列，admin 不改。 */
export interface BookChapterBodyInput {
  receiptNo?: number;
  sectionText: string;
  sectionNote?: string | null;
  fangJi?: string | null;
  fangJiZhujie?: string | null;
  bieMing?: string | null;
  isEnable?: boolean;
}

/** 来源书下拉选项（从 `book_info` 加载，供 `sourceBookId` 选择）。
 *  `caseDivision` = `book_info.case_division`，指向 `settings.book_groups` 的
 *  分组 `key`；左栏三层树靠它把书归到分类（不是新列，读既有列）。 */
export interface BookChapterSourceBook {
  id: string;
  bookName: string;
  bookNo: string;
  caseDivision: string;
}

/** 看板一次性返回：书籍分类清单 + 来源书下拉 + 卷章目录（含已软删行，
 *  `isDeleted` 区分）。
 *
 *  `groups` 的类型直接复用 `@/shared/BookInfo` 的 `BookInfoGroup` 真源——
 *  `settings.book_groups` 只有这一份定义，不在此重写接口、不另起
 *  「BookChapterGroup」这种会误读成卷章分组的名字。
 *  分类与书的归属是**只读派生**，不写 `book_info`/`settings`；左栏据此拼
 *  「分类 → 书名 → 卷」三层导航。正文**不在这里**：8066 行整表返回太重，
 *  选中卷章后走 `bodies` 端点按 `bookChapterId` 窄范围取（有 0181 索引）。 */
export interface BookChapterBoard {
  groups: BookInfoGroup[];
  sourceBooks: BookChapterSourceBook[];
  chapters: BookChapterAdmin[];
}

/** 卷章新建的结构 schema（**唯一真源**）。`chapterHeader` 不 trim、
 *  `chapterSection` 是源保真文本（VARCHAR(64)）。 */
export const bookChapterCreateSchema = z.object({
  chapterHeader: nonEmptyPreservingText(255),
  sourceBookId: z.string().max(11).nullable().optional(),
  sourceBookName: z.string().max(255).nullable().optional(),
  chapterSection: z.string().max(64).nullable().optional(),
  isEnable: z.boolean().optional(),
});

/** 卷章编辑载荷：同创建，字段皆可缺省（`undefined` = 不改）。 */
export const bookChapterUpdateSchema = bookChapterCreateSchema.partial();

/** 正文新建的结构 schema（**唯一真源**）。全部文本字段不 trim——正文的
 *  前导缩进、句号后空格、换行都是内容。`sectionText` 只校验非空。 */
export const bookChapterBodyCreateSchema = z.object({
  receiptNo: z.number().int().min(0).optional(),
  sectionText: z.string().min(1),
  sectionNote: z.string().nullable().optional(),
  fangJi: z.string().nullable().optional(),
  fangJiZhujie: z.string().nullable().optional(),
  bieMing: z.string().nullable().optional(),
  isEnable: z.boolean().optional(),
});

/** 正文编辑载荷：同创建，字段皆可缺省。 */
export const bookChapterBodyUpdateSchema = bookChapterBodyCreateSchema.partial();
