/**
 * 独立「本草」模块（ADR-0061）的 dashboard 视图类型 + Zod schema 真源。
 *
 * 这是一个与 `items`/`channels` 中药机制**完全解耦**的独立表 `zhong_yao`
 * （迁移 0180）。字段镜像 `ctwh/ZhongYao.sql` 的 `ZhongYao` 实体，但按
 * microfeed 惯例用 snake_case 列名 + camelCase JSON 形状。
 *
 * 与 `items`-中药（`tcm_kind='yao'` 行 + 通用 tcm-entry 链路）是两个不同
 * 概念：
 * - `items`-中药 = 既有内容链路（`items.data` JSON 叠 `_microfeed.no`/
 *   `yaoNames`/`aliases`），App 读取仍走它；
 * - `zhong_yao` = 本模块的独立模型（参考 `ZhongYao` 镜像）。
 * 两者并行共存、互不迁移（ADR-0061 决策 2）。
 *
 * 类型放 `shared` 而非 `server/zhong-yao/types.ts`，是为了让后台 UI
 * （`src/components/admin/zhong-yao/`）与 server 用同一形状给 AJAX 载荷
 * 定型——`MingCi.ts` / `BookInfo.ts` 就是这么做的。字段加在这里会同时在
 * 两侧报编译错，避免载荷悄悄不匹配。
 *
 * **无分组、无来源书**（对比 ADR-0060 `MingCi.ts`）：源实体无分类字段
 * （无 `MingCiType` 对应物），不伪造推导分组；无 `SoureBook` 对应物，故无
 * `source_book_id`、无 `ZhongYaoGroup` / `ZhongYaoSourceBook` / 分组 schema。
 * 这让本模块比 ming-ci 少一整套分组管理面（UI 无 `AdminGroupTree`，
 * server 无 groups/reassign handler）。
 *
 * **无状态枚举**：源只有 `IsEnable`（172/172 全 1），只留 `isEnable` 布尔，
 * 不建状态清单（与 ADR-0060 决策 1 同一取舍）。
 */

import {z} from "zod";

/**
 * `zhong_yao_list` 的切分符：中英文逗号/分号/空格/句号/顿号，对齐 netcore
 * `ZhongYaoService._splitPattern`。本草别名按纯逗号文本落库（见 ADR-0061 勘误），
 * 读取时用本标点集切回 `string[]`；store 与 App 读取层共用，避免两处各写一份正则。
 */
export const ZHONG_YAO_LIST_SPLIT_PATTERN = /[,，；; 。.、]+/;

/** 一列 `zhong_yao` 行在后台看板上的视图（camelCase，`isDeleted` 由
 *  `deleted_at` 派生，供两步删除流程区分「编辑/软删」与「物删」）。 */
export interface ZhongYaoAdmin {
  id: string;
  /** YaoNo 序号（显示/排序，非主键；唯一） */
  zhongYaoNo: number;
  /** YaoName 药名（必填） */
  zhongYaoName: string;
  /** YaoBieMing 别名（可空；源全 NULL，列位保留） */
  zhongYaoBeiMing: string | null;
  /** YaoText 正文（必填；含 `$u{}`/`$q{}` 标记 + 真实换行，原样存储不解析标记） */
  zhongYaoText: string;
  /** YaoList 别名列表（落库存纯逗号文本，读取时按标点集切回 `string[]`） */
  zhongYaoList: string[];
  /** IsEnable 启用（无状态枚举） */
  isEnable: boolean;
  /** SignatureId App 签名链路保真（列位保留，admin 不编辑） */
  signatureId: string | null;
  /** Signature App 签名链路保真（列位保留，admin 不编辑） */
  signature: string | null;
  /** True = 已软删（`deleted_at` 非空），看板只对这类行提供物删。 */
  isDeleted: boolean;
}

/** 新建/编辑 `zhong_yao` 的载荷。可空字段用 `| null` 表示「显式清空」，
 *  `undefined` 表示「不改」。`zhongYaoName`/`zhongYaoText` 非空——列是
 *  NOT NULL，更新时也不允许写成 null。`signatureId`/`signature` admin 不
 *  编辑，不在载荷里。 */
export interface ZhongYaoInput {
  zhongYaoName: string;
  zhongYaoBeiMing?: string | null;
  zhongYaoText: string;
  zhongYaoList?: string[];
  isEnable?: boolean;
}

/** 看板一次性返回：本草列表（含已软删行，`isDeleted` 区分）。无分组、无来源书，
 *  比 ming-ci board 少 `groups`/`sourceBooks` 两块。 */
export interface ZhongYaoBoard {
  entries: ZhongYaoAdmin[];
}

/**
 * 本草新建/编辑的结构 schema（**唯一真源**：UI 与 server 共用，`handlers.ts`
 * 从这里 import，不再各写一份）。**只保结构**（必填/类型/长度 + 可空文本
 * `trim`）；无分组，故无「命中分组 key」的 handler 侧严格校验（对比 ming-ci
 * `mingCiCreateSchema` + handler `assertMingCiTypeInGroups`）。
 *
 * `zhongYaoText` 只 `min(1)` 不 `trim`：正文里的真实换行（源 MySQL 转义序列
 * `\r\n`/`\n` 经迁移解析为真实 CR/LF）与 `$u{}`/`$q{}` 标记是内容本体，trim
 * 会动到首尾空白（源文本审计 §7 实测行尾空格 0，但编辑后的人工输入不应被
 * 悄悄改写）。`zhongYaoName`/`zhongYaoBeiMing` 仍 trim。
 */
export const zhongYaoCreateSchema = z.object({
  zhongYaoName: z.string().trim().min(1).max(255),
  zhongYaoBeiMing: z.string().trim().max(255).nullable().optional(),
  zhongYaoText: z.string().min(1),
  zhongYaoList: z.array(z.string()).optional(),
  isEnable: z.boolean().optional(),
});

/** 本草编辑载荷：同创建，但字段皆可缺省（`undefined` = 不改），
 *  `zhongYaoName`/`zhongYaoText` 若给则非空。 */
export const zhongYaoUpdateSchema = zhongYaoCreateSchema.partial();
