/**
 * 「书本信息」分组清单（ADR-0059）的读写层。
 *
 * 分组清单存 `settings` 表 category='book_groups'（独立管理，不依赖 channels/
 * items/ext_category），书的归属 = 自身 `case_division`（= 分组 `key`）。
 * 这里只留 IO + 解析校验；分组形状与清单 schema 的真源在 `@/shared/BookInfo`
 * （客户端分组弹层要本地预检，不能 import `@/server/*`），此处 re-export，
 * 读写层与测试的导入路径不变。与 `src/server/auth/signup-source.ts` 同构：
 * 读一行 settings、整表覆盖写、缺行/坏数据 fail-closed。
 */

import {z} from "zod";

import {SETTINGS_CATEGORIES} from "@/shared/Constants";
import type {BookInfoGroup} from "@/shared/BookInfo";
import {
  bookInfoGroupsSchema,
  bookInfoGroupSchema,
} from "@/shared/BookInfo";
import {
  readSettingsCategory,
  writeSettingsCategory,
} from "@/server/feed/settings-store";

export {bookInfoGroupsSchema, bookInfoGroupSchema};

/** 键长 11 < `settings.category` 的 VARCHAR(20)。 */
const CATEGORY = SETTINGS_CATEGORIES.BOOK_GROUPS;

/** settings 里存的形状；种子/历史数据可能带 `groups` 外的冗余键，解析时收窄。 */
const storedSchema = z.object({groups: z.array(bookInfoGroupSchema)});

/** 按 `sort`（次 `key`）稳定排序，供左栏按序渲染。 */
function sortGroups(groups: BookInfoGroup[]): BookInfoGroup[] {
  return [...groups].sort(
    (a, b) => a.sort - b.sort || a.key.localeCompare(b.key),
  );
}

/**
 * 读分组清单。缺行或坏 JSON 回落空数组（宽松——首次使用 / 空站点仍能建书，
 * ADR-0059 决策 5 口径），但**已存在却形状非法**的数据 fail-closed 抛错，
 * 不静默吞成空（镜像 `ext_user_permissions` 的 `parseCodes` 口径）。
 */
export async function loadBookGroups(
  db: D1Database,
): Promise<BookInfoGroup[]> {
  const parsed = await readSettingsCategory<unknown>(db, CATEGORY);
  if (parsed == null) return [];
  const result = storedSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("invalid_book_groups");
  }
  return sortGroups(result.data.groups);
}

/** 整表覆盖写分组清单。调用方先过 `bookInfoGroupsSchema` 校验（含 key 唯一）。 */
export async function saveBookGroups(
  db: D1Database,
  groups: BookInfoGroup[],
): Promise<void> {
  await writeSettingsCategory(db, CATEGORY, JSON.stringify({groups}));
}
