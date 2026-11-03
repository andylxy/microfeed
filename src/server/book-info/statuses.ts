/**
 * 「书本信息」状态清单（ADR-0058：迁移 0173/0174）的读写层。
 *
 * 状态清单存 `settings` 表 category='book_info_statuses'（独立管理，不依赖
 * channels/items/ext_*），书的状态 = 自身 `hot_book`（= 状态 `value`，NOT NULL）。
 * 这里只留 IO + 解析校验；状态形状与清单 schema 的真源在 `@/shared/BookInfo`
 * （客户端状态弹层要本地预检，不能 import `@/server/*`），此处 re-export，
 * 读写层与测试的导入路径不变。与 `groups.ts`（book_groups）同构：
 * 读一行 settings、整表覆盖写、缺行回落、坏数据 fail-closed。
 */

import {z} from "zod";

import {SETTINGS_CATEGORIES} from "@/shared/Constants";
import type {BookInfoStatus} from "@/shared/BookInfo";
import {
  bookInfoStatusesSchema,
  bookInfoStatusSchema,
} from "@/shared/BookInfo";
import {
  readSettingsCategory,
  writeSettingsCategory,
} from "@/server/feed/settings-store";

export {bookInfoStatusesSchema, bookInfoStatusSchema};

/** 键长 19 < `settings.category` 的 VARCHAR(20)。 */
const CATEGORY = SETTINGS_CATEGORIES.BOOK_INFO_STATUSES;

/** settings 里存的形状；种子/历史数据可能带 `statuses` 外的冗余键，解析时收窄。 */
const storedSchema = z.object({statuses: z.array(bookInfoStatusSchema)});

/** 按 `sort`（次 `value`）稳定排序，供下拉按序渲染。 */
function sortStatuses(statuses: BookInfoStatus[]): BookInfoStatus[] {
  return [...statuses].sort(
    (a, b) => a.sort - b.sort || a.value - b.value,
  );
}

/**
 * 读状态清单。缺行或坏 JSON 回落空数组（宽松——与分组同口径，空清单时调用方
 * 按「无数据源」处理），但**已存在却形状非法**的数据 fail-closed 抛错，
 * 不静默吞成空（镜像 `groups.ts` / `parseCodes` 口径）。
 */
export async function loadBookStatuses(
  db: D1Database,
): Promise<BookInfoStatus[]> {
  const parsed = await readSettingsCategory<unknown>(db, CATEGORY);
  if (parsed == null) return [];
  const result = storedSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("invalid_book_statuses");
  }
  return sortStatuses(result.data.statuses);
}

/** 整表覆盖写状态清单。调用方先过 `bookInfoStatusesSchema` 校验（含 value 唯一）。 */
export async function saveBookStatuses(
  db: D1Database,
  statuses: BookInfoStatus[],
): Promise<void> {
  await writeSettingsCategory(db, CATEGORY, JSON.stringify({statuses}));
}
