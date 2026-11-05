/**
 * 独立「方剂」模块（ADR-0065）的 shared 类型 + Zod 真源。
 *
 * 两张与 `items`/`channels`/`book_info`/`ming_ci`/`zhong_yao`/`book_chapter`
 * **完全解耦**的独立表（迁移 0184）：
 * - `fang_yao` = 804 行方剂主表（源自 `ctwh/FangYao.sql`）
 * - `fang_yao_body` = 2025 行方剂组成（源自 `ctwh/FangYaoBody.sql`，
 *   由 `scripts/import-ctwh/import-fangyao.mjs` 导入）
 *
 * 放在 `shared` 而非 `server/fang-yao/`，是因为后台 UI 与 server 要用同一
 * 形状给 AJAX 载荷定型——字段加在这里会同时在两侧报编译错，防载荷悄悄不匹配。
 * `handlers.ts` 只 import 这里的 schema，不再本地重写。
 *
 * ## 格式保真（ADR-0065 决策 4，执行期铁律）
 *
 * **所有文本字段一律不 `.trim()`**。源方文的格式远比名词/本草丰富：
 * 前导缩进、句号后空格、真实换行、制表符、字面 CR——这些都是内容，不是噪声。
 * 校验只做长度与非空，绝不改写值。UI 也必须原样提交。
 *
 * 唯一例外是 `fang_text` 的花括号配平，且**只在导入脚本里做一次**
 * （15 方 `{` 富余，导入时补 `}`）；此后 admin 编辑原样存，不再改写。
 *
 * ## 与 book-chapter 左栏的关键差异（ADR-0065 决策 5）
 *
 * 方剂左栏是**两层树**「源书 → 方」，分组键 = `source_book_legacy_id`（源库
 * BookId，5 组），组显示名 = `source_book_name`（导入派生）。**不联动
 * `book_info`**——方剂书不一定在 book_info 里，硬连会误绑，故无
 * `sourceBookId` 下拉、不引入三层「分类 → 书 → 方」。
 */

import {z} from "zod";

/** 未归属源书组的左栏兜底桶键：`source_book_legacy_id` 为空时方剂在左栏没有组可挂，
 *  不并入此桶就会被静默丢弃。生产数据 5 组均有 legacy id，此桶预期空。
 *  唯一真源——server `handlers.ts` 与后台 UI `FangYaoApp.tsx` 共用此常量，
 *  禁止各写一份（防止哨兵键漂移导致「组键判空」与「渲染归组」口径不一致）。 */
export const UNGROUPED_KEY = "__ungrouped__";

/**
 * 非空文本：长度 ≥ 1 且 trim 后仍有可见字符。
 *
 * `refine` 只用于拒绝「全空白」这种无意义输入，**不修改值**——前后空格、
 * 换行、制表符原样保留。
 */
const nonEmptyPreservingText = (max?: number) => {
  const base = max === undefined ? z.string().min(1) : z.string().min(1).max(max);
  return base.refine((value) => value.trim() !== "", {message: "blank_text"});
};

/** 一行 `fang_yao` 在后台看板上的视图（camelCase）。
 *  `isDeleted` 由 `deleted_at` 派生，供两步删除流程区分「编辑/软删」与「物删」。 */
export interface FangYaoAdmin {
  id: string;
  /** 显示/排序序号（**组内连续唯一**；新建走组内 MAX+1）。
   *  绝不复用源 FangNo（1001000 组内重复 + 跨书重叠，ADR-0065 P1 甲）。 */
  fangNo: number;
  /** 方名（必填；219 名/588 行同名，不 UNIQUE） */
  fangName: string;
  /** 源 BookId（左栏分组键；5 书源组 329/202/113/111/49） */
  sourceBookLegacyId: string | null;
  /** 源书名（**导入派生、只读**；组显示名兜底） */
  sourceBookName: string | null;
  /** 源 FangYao.Id 只读历史（UNIQUE，可追溯；正文导入的映射键） */
  sourceFangLegacyId: string | null;
  /** 源 YaoList（逗号分隔多值，原样存不解析） */
  yaoList: string | null;
  /** 方文（必填；9 类 `$单字母{}` 标记原样存；`{}` 已由导入脚本配平） */
  fangText: string;
  /** 源 FangdrinkNum（VARCHAR 保真，含小数 `1.5` 与 NULL，不转数值） */
  fangDrinkNum: string | null;
  /** 源 IsEnable（导入全量含禁用） */
  isEnable: boolean;
  /** 源 SignatureId（列位保留，admin 不编辑） */
  signatureId: string | null;
  /** 源 Signature（唯一 797/804；列位保留，admin 不编辑，不作 ETag） */
  signature: string | null;
  /** True = 已软删（`deleted_at` 非空），看板只对这类行提供物删。 */
  isDeleted: boolean;
  /** 味数 = **未软删**组成行数（ADR-0065 决策5：**读侧 COUNT 派生，不物化存储**）。
   *  看板一次取齐，右栏详情直接显示，无需再查。软删的组成不再计为「味」。
   *  ⚠️ 与 `countBodiesByFang`（**含软删**、供物删守卫判「还有无组成行」）语义
   *  不同：味数是 UI 展示（当前组成），后者是引用完整性守卫（任何行都不许孤悬）。 */
  yaoCount: number;
}

/** 一行 `fang_yao_body` 的视图（camelCase）。 */
export interface FangYaoBodyAdmin {
  id: string;
  /** → `fang_yao.id`（逻辑引用；导入按 `source_fang_legacy_id` 映射） */
  fangYaoId: string;
  /** 源排序键（方内唯一有序） */
  position: number;
  /** 药材显示名 */
  showName: string | null;
  /** 用量（内嵌 `$x{}` 22 行，原样存储不解析） */
  amount: string | null;
  /** 炮制 */
  extraProcess: string | null;
  /** 重量 */
  weight: string | null;
  /** 源 YaoID（**含 `-1` 两行，原样存、只读**） */
  yaoLegacyId: string | null;
  /** 源 IsEnable */
  isEnable: boolean;
  /** 源 SignatureId（列位保留，admin 不编辑） */
  signatureId: string | null;
  /** 源 Signature（列位保留） */
  signature: string | null;
  /** True = 已软删。 */
  isDeleted: boolean;
}

/** 新建/编辑方剂的载荷。可空字段用 `| null` 表示「显式清空」，`undefined`
 *  表示「不改」。`fangNo` 不由客户端给（store 走组内 MAX+1）。 */
export interface FangYaoInput {
  fangName: string;
  sourceBookLegacyId?: string | null;
  sourceBookName?: string | null;
  yaoList?: string | null;
  fangText: string;
  fangDrinkNum?: string | null;
  isEnable?: boolean;
}

/** 新建/编辑组成的载荷。`position` 缺省时 store 取方内 `MAX+1`。
 *  `yaoLegacyId` 可编辑（含 `-1` 的历史行原样存）。 */
export interface FangYaoBodyInput {
  position?: number;
  showName?: string | null;
  amount?: string | null;
  extraProcess?: string | null;
  weight?: string | null;
  yaoLegacyId?: string | null;
  isEnable?: boolean;
}

/** 左栏一层组 = 源书（按 `source_book_legacy_id` 聚合，两层树的顶层）。
 *  `count` 由页面侧算好传入 `AdminGroupTree`（组件只渲染传入状态）。 */
export interface FangYaoSourceGroup {
  /** `source_book_legacy_id`；空值归一组用哨兵键 `UNGROUPED_KEY` */
  key: string;
  /** 组显示名 = `source_book_name` 兜底 */
  name: string;
  /** 组内未软删方剂数 */
  count: number;
}

/** 看板一次性返回：源书分组清单 + 方剂目录（含已软删行，`isDeleted` 区分）。
 *
 *  组与方的归属是**只读派生**（按 `source_book_legacy_id` 聚合），不写任何
 *  他人表。组成行**不在这里**：2025 行整表返回偏重，选中某方后走 `bodies`
 *  端点按 `fangYaoId` 窄范围取（有 0184 索引）。 */
export interface FangYaoBoard {
  groups: FangYaoSourceGroup[];
  formulas: FangYaoAdmin[];
}

/** 方剂新建的结构 schema（**唯一真源**）。`fangName`/`fangText` 不 trim——
 *  方文的前导缩进、换行、制表符都是内容。 */
export const fangYaoCreateSchema = z.object({
  fangName: nonEmptyPreservingText(255),
  sourceBookLegacyId: z.string().max(64).nullable().optional(),
  sourceBookName: z.string().max(255).nullable().optional(),
  yaoList: z.string().nullable().optional(),
  fangText: z.string().min(1),
  fangDrinkNum: z.string().max(64).nullable().optional(),
  isEnable: z.boolean().optional(),
});

/** 方剂编辑载荷：同创建，字段皆可缺省（`undefined` = 不改）。 */
export const fangYaoUpdateSchema = fangYaoCreateSchema.partial();

/** 组成新建的结构 schema（**唯一真源**）。全部文本字段不 trim——用量里的
 *  `$x{}` 标记、空格都是内容。`position` 只校验非负整数。 */
export const fangYaoBodyCreateSchema = z.object({
  position: z.number().int().min(0).optional(),
  // 药材名必填非空（ADR-0065 表结构 NOT NULL）：UI validateBody 已强制非空、
  // 源数据 2025/2025 非空，此约束与之对齐，防「空药材名」经 API 漏入。
  showName: nonEmptyPreservingText(64),
  amount: z.string().max(255).nullable().optional(),
  extraProcess: z.string().max(64).nullable().optional(),
  weight: z.string().max(32).nullable().optional(),
  yaoLegacyId: z.string().max(64).nullable().optional(),
  isEnable: z.boolean().optional(),
});

/** 组成编辑载荷：同创建，字段皆可缺省。 */
export const fangYaoBodyUpdateSchema = fangYaoBodyCreateSchema.partial();
