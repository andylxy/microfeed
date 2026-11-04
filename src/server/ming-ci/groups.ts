/**
 * 「名词」分组清单（ADR-0060）的读写层。
 *
 * 分组清单存 `settings` 表 category='mingci_groups'（独立管理，不依赖 items/
 * channels/ext_*），名词归属 = 自身 `ming_ci_type`（= 分组 `key`）。
 * 这里只留 IO + 解析校验；分组形状与清单 schema 的真源在 `@/shared/MingCi`
 * （客户端分组弹层要本地预检，不能 import `@/server/*`），此处 re-export，
 * 读写层与测试的导入路径不变。与 `src/server/book-info/groups.ts` 同构：
 * 读一行 settings、整表覆盖写、缺行/坏数据 fail-closed。
 */

import {z} from "zod";

import {SETTINGS_CATEGORIES} from "@/shared/Constants";
import type {MingCiGroup} from "@/shared/MingCi";
import {
  mingCiGroupsSchema,
  mingCiGroupSchema,
} from "@/shared/MingCi";
import {
  readSettingsCategory,
  writeSettingsCategory,
} from "@/server/feed/settings-store";

export {mingCiGroupsSchema, mingCiGroupSchema};

/** 键长 11 < `settings.category` 的 VARCHAR(20)。 */
const CATEGORY = SETTINGS_CATEGORIES.MINGCI_GROUPS;

/** settings 里存的形状；种子/历史数据可能带 `groups` 外的冗余键，解析时收窄。 */
const storedSchema = z.object({groups: z.array(mingCiGroupSchema)});

/** 按 `sort`（次 `key`）稳定排序，供左栏按序渲染。 */
function sortGroups(groups: MingCiGroup[]): MingCiGroup[] {
  return [...groups].sort(
    (a, b) => a.sort - b.sort || a.key.localeCompare(b.key),
  );
}

/**
 * 读分组清单。缺行或坏 JSON 回落空数组（宽松——首次使用 / 空站点仍能渲染
 * 空左栏，ADR-0060 决策 4 口径），但**已存在却形状非法**的数据 fail-closed
 * 抛错，不静默吞成空（镜像 `ext_user_permissions` 的 `parseCodes` 口径）。
 * 注：`ming_ci_type` 的写侧严格校验命中 key 在 handler 层做（空清单 = 拒写）。
 */
export async function loadMingCiGroups(
  db: D1Database,
): Promise<MingCiGroup[]> {
  const parsed = await readSettingsCategory<unknown>(db, CATEGORY);
  if (parsed == null) return [];
  const result = storedSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("invalid_mingci_groups");
  }
  return sortGroups(result.data.groups);
}

/** 整表覆盖写分组清单。调用方先过 `mingCiGroupsSchema` 校验（含 key 唯一）。 */
export async function saveMingCiGroups(
  db: D1Database,
  groups: MingCiGroup[],
): Promise<void> {
  await writeSettingsCategory(db, CATEGORY, JSON.stringify({groups}));
}
