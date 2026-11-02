/**
 * 注册来源（`signup_sources`）的读写层。
 *
 * 形状、默认值与校验都在 `@/shared/SignupSource`（浏览器也要用同一份）。这里
 * 只留 IO：读一行 `settings`、整表覆盖写、以及保存前要用的"这些来源还有多少
 * 账号在用"的计数。
 *
 * ## 读路径不回写
 *
 * 缺行或坏数据一律回落到 {@link DEFAULT_SIGNUP_SOURCES}，并且把库里实际出现过、
 * 但配置里没有的来源补成临时分组（见 {@link getSignupSources}）。两件事都**不
 * 落库**：用户页每次 SSR 都会读它，写在这里等于给每个 GET 加一次写。种子行与
 * 补全项由第一次「保存分组」转正。这与 `src/server/mail/mail-config.ts` 的
 * 默认值口径一致。
 */

import {SETTINGS_CATEGORIES} from "@/shared/Constants";
import {
  DEFAULT_SIGNUP_SOURCES,
  isValidSignupSourceValue,
  validateSignupSources,
  type SignupSourceOption,
} from "@/shared/SignupSource";

import {
  readSettingsCategory,
  writeSettingsCategory,
} from "@/server/feed/settings-store";

/** 键长 14 < `settings.category` 的 VARCHAR(20)。 */
const CATEGORY = SETTINGS_CATEGORIES.SIGNUP_SOURCES;

/**
 * 读来源列表：`settings` 里的配置 **∪** 库里实际出现过的来源。
 *
 * 补全这一步是为了「账号必须都能在左栏找到」：手工 SQL 写进去的值（本机实测
 * 有 2 行 `back`）不在配置里，若按配置分桶就会让那些账号从树上消失。补出来的
 * 项 label 用 value 本身，管理员可以在「管理分组」里改显示名；一保存就变成正式
 * 配置。**不写库**——用户页每次 SSR 都会读它，写在这里等于给每个 GET 加一次写。
 *
 * 代价：多一条 `SELECT DISTINCT signup_source`（`auth_user` 表，行数等于账号数）。
 * 该列有 `ix_auth_user_signup_source`（迁移 0170），实测计划从
 * `SCAN auth_user` + `USE TEMP B-TREE FOR DISTINCT` 变成
 * `SCAN auth_user USING COVERING INDEX`，临时 B-tree 消失；没有索引时这条查询
 * 会随账号数线性增长且每次用户页加载都付一遍。
 */
export async function getSignupSources(
  database: D1Database,
): Promise<SignupSourceOption[]> {
  const parsed = await readSettingsCategory<unknown>(database, CATEGORY);
  const configured = validateSignupSources(parsed)
    ? [...parsed]
    : [...DEFAULT_SIGNUP_SOURCES];
  const known = new Set(configured.map((option) => option.value));
  const defaultLabel = new Map(
    DEFAULT_SIGNUP_SOURCES.map((option) => [option.value, option.label]),
  );
  const observed = await database
    .prepare(
      'SELECT DISTINCT "signup_source" AS value FROM "auth_user" ' +
        'WHERE "signup_source" IS NOT NULL AND "signup_source" <> \'\'',
    )
    .all<{value: string}>();
  for (const row of observed.results ?? []) {
    // 格式不合法的值不补：一个坏值会让整份列表过不了 `validateSignupSources`，
    // 读路径随之回落到默认值，管理员自建的分组全部隐形——比"少一个分组"糟得多。
    if (!isValidSignupSourceValue(row.value)) continue;
    if (known.has(row.value)) continue;
    known.add(row.value);
    configured.push({
      label: defaultLabel.get(row.value) ?? row.value,
      value: row.value,
    });
  }
  return configured;
}

/** 整表覆盖写。非法列表直接抛错——调用方应先用 `validateSignupSources` 挡过。 */
export async function setSignupSources(
  database: D1Database,
  sources: SignupSourceOption[],
): Promise<void> {
  if (!validateSignupSources(sources)) {
    throw new Error("invalid_signup_sources");
  }
  await writeSettingsCategory(database, CATEGORY, JSON.stringify(sources));
}

/**
 * 这些来源各自还被多少个账号用着。
 *
 * 保存分组列表前拿它挡一道：删掉一个仍有账号的来源，那些账号的
 * `signup_source` 就变成了列表外的值——左栏没有它们的分组，账号等于凭空消失。
 *
 * 计划（迁移 0170 的索引生效后）：`SCAN auth_user USING COVERING INDEX
 * ix_auth_user_signup_source` + `GROUP BY` 走索引顺序，无临时 B-tree。行读等于
 * 命中分组的账号数上限，即全表行数（本机 9 行）；只在 PUT 时跑，不在页面路径上。
 */
export async function countAccountsBySource(
  database: D1Database,
  values: readonly string[],
): Promise<Record<string, number>> {
  if (values.length === 0) return {};
  const placeholders = values.map(() => "?").join(", ");
  const rows = await database
    .prepare(
      `SELECT "signup_source" AS source, COUNT(*) AS n FROM "auth_user" ` +
        `WHERE "signup_source" IN (${placeholders}) GROUP BY "signup_source"`,
    )
    .bind(...values)
    .all<{n: number; source: string}>();
  const counts: Record<string, number> = {};
  for (const row of rows.results ?? []) {
    counts[row.source] = Number(row.n);
  }
  return counts;
}
