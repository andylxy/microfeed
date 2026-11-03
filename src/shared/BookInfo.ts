/**
 * 独立「书本信息」模块（ADR-0058）的 dashboard 视图类型。
 *
 * 这是一个与 `channels`/`items` 书机制**完全解耦**的独立表 `book_info`
 * （迁移 0171）。字段镜像 `vol.api.sqlsugar` 的 `BookInfo` 实体，
 * 但按 microfeed 惯例用 snake_case 列名 + camelCase JSON 形状。
 *
 * 与 `ExtBook.ts` 的 `BookAdmin`（`channels` 行）是两个不同概念：
 * - `Book`（书）= `channels` 行，既有 novel-cms 主书模型；
 * - `BookInfo`（书本信息）= `book_info` 行，本模块的独立模型。
 * 两者并行共存、互不迁移（ADR-0058 决策 2/3）。
 *
 * 类型放 `shared` 而非 `server/book-info/types.ts`，是为了让后台 UI
 * （`src/components/admin/book-info/`）与 server 用同一形状给 AJAX 载荷
 * 定型——`ExtBook.ts` 的 `BookAdmin` 就是这么做的。字段加在这里会同时在
 * 两侧报编译错，避免载荷悄悄不匹配。
 */

import {z} from "zod";

/** 一列 `book_info` 行在后台看板上的视图（camelCase，`isDeleted` 由
 *  `deleted_at` 派生，供两步删除流程区分「编辑/软删」与「物删」）。 */
export interface BookInfoAdmin {
  id: string;
  /** BookName 书名 */
  bookName: string;
  /** Chapter 总卷章数（可空） */
  chapter: number | null;
  /** Author 作者 */
  author: string;
  /** ChengShu 成书时间 */
  chengShu: string;
  /** Case 书籍分类（`case` 为保留字 → `case_division`；必填，取值 = 分组 `key`） */
  caseDivision: string;
  /** CaseTag 内容标签（迁移 0173 起为文本列） */
  caseTag: string;
  /** BookNo 书本编号（迁移 0173 起为文本列，看板排序键改 `bookName`） */
  bookNo: string;
  /** ImageUrl 封面 */
  imageUrl: string;
  /** HotBook 状态（NOT NULL，取值 = 状态清单 `BookInfoStatus.value`） */
  hotBook: number;
  /** ParentId 父级（逻辑自引用，microfeed 惯例无外键） */
  parentId: string | null;
  /** OrgId 书籍性质（列位保留，无组织模块） */
  orgId: number | null;
  /** IsEnable 启用 */
  isEnable: boolean;
  /** Comment 备注 */
  comment: string;
  /** True = 已软删（`deleted_at` 非空），看板只对这类行提供物删。 */
  isDeleted: boolean;
}

/** 新建/编辑 `book_info` 的载荷。可空字段用 `| null` 表示「显式清空」，
 *  `undefined` 表示「不改」。`bookName`/`caseDivision`/`bookNo` 非空——
 *  列是 NOT NULL，更新时也不允许写成 null。`hotBook` 是状态下拉的取值
 *  （NOT NULL），取值须在状态清单内（handler 按 settings 清单校验）。 */
export interface BookInfoInput {
  bookName: string;
  chapter?: number | null;
  author?: string | null;
  chengShu?: string | null;
  caseDivision: string;
  caseTag?: string;
  bookNo: string;
  imageUrl?: string | null;
  hotBook: number;
  parentId?: string | null;
  orgId?: number | null;
  isEnable?: boolean;
  comment?: string | null;
}

/** 一个「书本信息」分组（ADR-0059）。分组清单存 `settings.book_groups`，
 *  独立管理、不依赖 channels/items/ext_category。`key` 是书表 `case_division`
 *  存的稳定 slug（改名只动 settings，无级联），`sort` 是树内顺序。 */
export interface BookInfoGroup {
  key: string;
  label: string;
  sort: number;
}

/** 看板一次性返回：分组清单 + 状态清单 + 书列表（含已软删行，`isDeleted` 区分）。 */
export interface BookInfoBoard {
  groups: BookInfoGroup[];
  statuses: BookInfoStatus[];
  books: BookInfoAdmin[];
}

/**
 * 一个「书本信息」状态（ADR-0058：迁移 0173 把 `hot_book` 定为 NOT NULL 状态列）。
 *
 * 清单存 `settings.book_info_statuses`，独立管理、不依赖 channels/items/ext_*。
 * `value` 是书表 `hot_book` 存的整数（公开=0/隐藏=1/会员=2），`label` 是下拉显示名，
 * `sort` 是下拉内顺序。`hot_book` NOT NULL，取值必须在清单内（handler 按清单校验），
 * 故状态清单不可清空（fail-closed）——与分组「末组不可删」同口径。
 */
export interface BookInfoStatus {
  value: number;
  label: string;
  sort: number;
}

/**
 * 分组的真源 schema，UI 与 server 共用（形状见上 `BookInfoGroup`）。
 *
 * 放 `shared` 而非 `server/book-info/groups.ts`，是因为分组管理弹层要在客户端
 * 本地校验「新增一行」的 key/label——若从 `@/server/...` import，客户端组件就
 * 拖进服务端模块（本仓库 `src/components` 不 import `@/server`）。服务端
 * `groups.ts` re-export 这里，读写层与测试的导入路径不变。
 *
 * `key` 是稳定 slug：书表 `case_division` 存它，改名只动 settings 无级联。
 * `key` 在清单内唯一（重复会让左栏分桶与改派目标歧义）由清单级 refine 管。
 */
export const bookInfoGroupSchema = z.object({
  key: z.string().trim().min(1).max(255),
  label: z.string().trim().min(1).max(255),
  sort: z.number().int().min(0),
});

/** 整个清单：`key` 唯一。 */
export const bookInfoGroupsSchema = z.object({
  groups: z.array(bookInfoGroupSchema),
}).refine(
  (value) => new Set(value.groups.map((group) => group.key)).size === value.groups.length,
  {message: "duplicate_group_key"},
);

/**
 * 状态的真源 schema，UI 与 server 共用（形状见上 `BookInfoStatus`）。
 *
 * 与分组 schema 同放 `shared`：状态管理弹层要在客户端本地校验「新增一行」的
 * value/label——若从 `@/server/...` import，客户端组件就拖进服务端模块。服务端
 * `statuses.ts` re-export 这里，读写层与测试的导入路径不变。
 *
 * `value` 是书表 `hot_book` 存的整数（D1 整数 32 位有符号，上限 2^31-1），
 * 在清单内唯一（重复会让「状态下拉」取值歧义）由清单级 refine 管。
 */
export const bookInfoStatusSchema = z.object({
  value: z.number().int().min(0).max(2147483647),
  label: z.string().trim().min(1).max(255),
  sort: z.number().int().min(0),
});

/** 整个清单：`value` 唯一。 */
export const bookInfoStatusesSchema = z.object({
  statuses: z.array(bookInfoStatusSchema),
}).refine(
  (value) => new Set(value.statuses.map((status) => status.value)).size === value.statuses.length,
  {message: "duplicate_status_value"},
);
