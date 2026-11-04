/**
 * 独立「名词」模块（ADR-0060）的 dashboard 视图类型。
 *
 * 这是一个与 `items`/`channels` 名词机制**完全解耦**的独立表 `ming_ci`
 * （迁移 0177）。字段镜像 `vol.api.sqlsugar` 的 `BeiMingCi` 实体，
 * 但按 microfeed 惯例用 snake_case 列名 + camelCase JSON 形状。
 *
 * 与 `items`-名词（`tcm_kind='term'` 行 + 通用 tcm-entry 链路）是两个不同
 * 概念：
 * - `items`-名词 = 既有内容链路（`items.data` JSON 叠 `_microfeed.no`/
 *   `mingCiList`/`sourceImagePath`），App 读取仍走它；
 * - `ming_ci` = 本模块的独立模型（参考 `BeiMingCi` 镜像）。
 * 两者并行共存、互不迁移（ADR-0060 决策 2）。
 *
 * 类型放 `shared` 而非 `server/ming-ci/types.ts`，是为了让后台 UI
 * （`src/components/admin/ming-ci/`）与 server 用同一形状给 AJAX 载荷
 * 定型——`BookInfo.ts` 的 `BookInfoAdmin` 就是这么做的。字段加在这里会
 * 同时在两侧报编译错，避免载荷悄悄不匹配。
 */

import {z} from "zod";

/** 一列 `ming_ci` 行在后台看板上的视图（camelCase，`isDeleted` 由
 *  `deleted_at` 派生，供两步删除流程区分「编辑/软删」与「物删」）。 */
export interface MingCiAdmin {
  id: string;
  /** MingCiNo 名词ID（显示/排序，非主键；唯一） */
  mingCiNo: number;
  /** MingCiName 名词名称（必填） */
  mingCiName: string;
  /** MingCiBeiMing 名词别名（可空） */
  mingCiBeiMing: string | null;
  /** MingCiText 名词内容（必填；含 `$m{}/$n{}/$x{}/$a{}` 标记，原样存储不解析） */
  mingCiText: string;
  /** MingCiList 别名列表（JSON 数组，镜像 App 形状 `mingCiList: string[]`） */
  mingCiList: string[];
  /** SoureBook 名词来源书 → `book_info.id`（逻辑引用，无硬外键） */
  sourceBookId: string | null;
  /** MingCiType 归纳分类（必填；取值 = 分组 `key`，严格校验命中 `mingci_groups`） */
  mingCiType: string;
  /** ShowImage 展示图（源路径字符串；microfeed 内不一定可解析，UI 降级） */
  showImage: string | null;
  /** Remark 备注 */
  remark: string | null;
  /** IsEnable 启用（无状态枚举） */
  isEnable: boolean;
  /** SignatureId App 签名链路保真（列位保留，admin 不编辑） */
  signatureId: string | null;
  /** Signature App 签名链路保真（列位保留，admin 不编辑） */
  signature: string | null;
  /** True = 已软删（`deleted_at` 非空），看板只对这类行提供物删。 */
  isDeleted: boolean;
}

/** 新建/编辑 `ming_ci` 的载荷。可空字段用 `| null` 表示「显式清空」，
 *  `undefined` 表示「不改」。`mingCiName`/`mingCiText`/`mingCiType` 非空——
 *  列是 NOT NULL，更新时也不允许写成 null。`mingCiType` 的取值须命中
 *  `mingci_groups` 的 `key`（handler 按 settings 清单严格校验，未命中 400）。 */
export interface MingCiInput {
  mingCiName: string;
  mingCiBeiMing?: string | null;
  mingCiText: string;
  mingCiList?: string[];
  sourceBookId?: string | null;
  mingCiType: string;
  showImage?: string | null;
  remark?: string | null;
  isEnable?: boolean;
}

/** 一个「名词」分组（ADR-0060，镜像 ADR-0059 `book_groups`）。分组清单存
 *  `settings.mingci_groups`，独立管理、不依赖 items/channels/ext_*。`key` 是
 *  名词表 `ming_ci_type` 存的稳定 slug（改名只动 settings，无级联），
 *  `sort` 是树内顺序。 */
export interface MingCiGroup {
  key: string;
  label: string;
  sort: number;
}

/** 来源书下拉选项（从 `book_info` 加载，供 `source_book_id` 选择）。 */
export interface MingCiSourceBook {
  id: string;
  bookName: string;
  bookNo: string;
}

/** 看板一次性返回：分组清单 + 来源书下拉 + 名词列表（含已软删行，`isDeleted` 区分）。 */
export interface MingCiBoard {
  groups: MingCiGroup[];
  sourceBooks: MingCiSourceBook[];
  nouns: MingCiAdmin[];
}

/**
 * 分组的真源 schema，UI 与 server 共用（形状见上 `MingCiGroup`）。
 *
 * 放 `shared` 而非 `server/ming-ci/groups.ts`，是因为分组管理弹层要在客户端
 * 本地校验「新增一行」的 key/label——若从 `@/server/...` import，客户端组件就
 * 拖进服务端模块（本仓库 `src/components` 不 import `@/server`）。服务端
 * `groups.ts` re-export 这里，读写层与测试的导入路径不变。
 *
 * `key` 是稳定 slug：名词表 `ming_ci_type` 存它，改名只动 settings 无级联。
 * `key` 在清单内唯一（重复会让左栏分桶与改派目标歧义）由清单级 refine 管。
 */
export const mingCiGroupSchema = z.object({
  key: z.string().trim().min(1).max(255),
  label: z.string().trim().min(1).max(255),
  sort: z.number().int().min(0),
});

/** 整个清单：`key` 唯一。 */
export const mingCiGroupsSchema = z.object({
  groups: z.array(mingCiGroupSchema),
}).refine(
  (value) => new Set(value.groups.map((group) => group.key)).size === value.groups.length,
  {message: "duplicate_group_key"},
);

/** 名词新建/编辑的结构 schema（**唯一真源**：UI 与 server 共用，`handlers.ts` 从这里
 *  import，不再各写一份）。**只保结构**（必填/类型/长度 + 可空文本 `trim`）；
 *  `ming_ci_type` 命中 `mingci_groups.key` 的严格校验由 handler 按 settings
 *  清单兜底（镜像 ADR-0059 `case_division` 的 handler 侧校验）。 */
export const mingCiCreateSchema = z.object({
  mingCiName: z.string().trim().min(1).max(255),
  mingCiBeiMing: z.string().trim().max(255).nullable().optional(),
  mingCiText: z.string().min(1),
  mingCiList: z.array(z.string()).optional(),
  sourceBookId: z.string().max(11).nullable().optional(),
  mingCiType: z.string().trim().min(1).max(255),
  showImage: z.string().trim().max(255).nullable().optional(),
  remark: z.string().trim().max(1024).nullable().optional(),
  isEnable: z.boolean().optional(),
});

/** 名词编辑载荷：同创建，但字段皆可缺省（`undefined` = 不改），
 *  `mingCiName`/`mingCiText`/`mingCiType` 若给则非空。 */
export const mingCiUpdateSchema = mingCiCreateSchema.partial();
