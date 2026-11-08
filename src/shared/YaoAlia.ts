/**
 * 独立「药材别名」模块（ADR-0064）的 dashboard 视图类型 + Zod schema 真源。
 *
 * 这是一个与 App 别名链路**完全解耦**的独立表 `yao_alia`（迁移 0183）：
 * App 链路是 `items` 口袋字段（`aliases`/`yaoNames`/`bieMing`）→ `getDerivedYaoAliases`
 * 三源合并 → `GetAliaZhongYao` + 24h 缓存；退役的手工别名维护层见 ADR-0068。
 * 本模块镜像 `ctwh/YaoAlia.sql` 的 `YaoAlia` 实体，只自持一张表，两套别名模型
 * 并行共存、互不读写、互不迁移（ADR-0064 决策 1/2）。
 *
 * 类型放 `shared` 而非 `server/yao-alia/types.ts`，是为了让后台 UI
 * （`src/components/admin/yao-alia/`）与 server 用同一形状给 AJAX 载荷定型——
 * `MingCi.ts` / `ZhongYao.ts` / `BookInfo.ts` 就是这么做的。字段加在这里会同时在
 * 两侧报编译错，避免载荷悄悄不匹配。
 *
 * **无状态枚举**：源只有 `IsEnable`（47/47 全 1），只留 `isEnable` 布尔，
 * 不建状态清单（与 ADR-0060 决策 1 同一取舍）。
 *
 * **无 settings 分组**：左栏按正名 `yaoName` 只读派生分组（30 个正名 / 47 行），
 * 分组纯客户端派生，零 settings 读写、零 groups/reassign 端点、零改派
 * （ADR-0064 决策 3）。这与 ming-ci 的 `ming_ci_type` 严格校验分组 key 不同——
 * 别名的「分组键」是数据里的 `yaoName` 列，不是引用 settings 的 key，故无
 * 「命中分组 key」的 handler 侧校验。
 */

import {z} from "zod";

/** 一列 `yao_alia` 行在后台看板上的视图（camelCase，`isDeleted` 由
 *  `deleted_at` 派生，供两步删除流程区分「编辑/软删」与「物删」）。 */
export interface YaoAliaAdmin {
  id: string;
  /** yaoAliasNo 序号（显示/排序，非主键；唯一） */
  yaoAliaNo: number;
  /** YaoBieMing 别名（必填，唯一；软删行仍占用该唯一键） */
  bieMing: string;
  /** YaoName 正名（必填，非唯一；左栏按它只读派生分组） */
  yaoName: string;
  /** IsEnable 启用（无状态枚举） */
  isEnable: boolean;
  /** SignatureId App 签名链路保真（列位保留，admin 不编辑；源全 NULL） */
  signatureId: string | null;
  /** Signature App 签名链路保真（列位保留，admin 不编辑；源全 NULL） */
  signature: string | null;
  /** True = 已软删（`deleted_at` 非空），看板只对这类行提供物删。 */
  isDeleted: boolean;
}

/** 新建/编辑 `yao_alia` 的载荷。两个字段皆非空——列是 NOT NULL，更新时也不允许
 *  写成 null。`signatureId`/`signature` admin 不编辑，不在载荷里。
 *  `undefined` 表示「不改」（编辑态），新建态两字段都必填。 */
export interface YaoAliaInput {
  bieMing: string;
  yaoName: string;
  isEnable?: boolean;
}

/** 看板一次性返回：别名列表（含已软删行，`isDeleted` 区分）。无分组、无来源书——
 *  左栏分组由 UI 按 `yaoName` 派生，server 不返回 groups（ADR-0064 决策 3）。 */
export interface YaoAliaBoard {
  entries: YaoAliaAdmin[];
}

/**
 * 别名新建的结构 schema（**唯一真源**：UI 与 server 共用，`handlers.ts`
 * 从这里 import，不再各写一份）。**只保结构**（必填/类型/长度 + `trim`）；
 * 分组键 `yaoName` 是数据列不是 settings key，故无「命中分组 key」校验
 * （对比 ming-ci `mingCiCreateSchema` + handler `assertMingCiTypeInGroups`）。
 *
 * `bieMing`/`yaoName` 都 trim：源审计实测两列行尾空格 0、别名内空格 0、无 CR/LF，
 * 是纯短标签；trim 让人工输入的首尾空白不进库（长度上限 255 与源列宽一致）。
 * 唯一性（`bieMing` UNIQUE）不在 schema 层管——它靠表约束 + store 写入时
 * UNIQUE 冲突 fail-fast，这里只管结构。
 */
export const yaoAliaCreateSchema = z.object({
  bieMing: z.string().trim().min(1).max(255),
  yaoName: z.string().trim().min(1).max(255),
  isEnable: z.boolean().optional(),
});

/** 别名编辑载荷：同创建，但字段皆可缺省（`undefined` = 不改），
 *  若给则非空（NOT NULL 列不接受 null，`.trim().min(1)` 已拒空串）。 */
export const yaoAliaUpdateSchema = yaoAliaCreateSchema.partial();
