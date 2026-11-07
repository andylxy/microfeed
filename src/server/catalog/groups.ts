/**
 * 前台题材分类只读层（ADR-0066 决策 2）。
 *
 * 分组清单的真源是 `settings.book_groups`，书本数由 `book_info.case_division`
 * 聚合，不经过旧分类表。函数只收 `D1Database`，页面用 `env.FEED_DB` 传入。
 */
import {loadBookGroups} from "@/server/book-info/groups";

export interface CatalogGroup {
  /** = settings.book_groups.key = book_info.case_division = /category/<key>/ 的 slug */
  key: string;
  label: string;
  bookCount: number;
}

/** 按分组清单顺序（`sort` 次 `key`）列出，书本数一条 GROUP BY 聚合补齐。 */
export async function listGroups(db: D1Database): Promise<CatalogGroup[]> {
  const groups = await loadBookGroups(db);
  if (groups.length === 0) return [];
  const {results} = await db
    .prepare(
      "SELECT case_division AS division, COUNT(*) AS total " +
        "FROM book_info WHERE deleted_at IS NULL GROUP BY case_division",
    )
    .all<{division: string | null; total: number}>();
  const counts = new Map<string, number>();
  for (const row of results ?? []) {
    counts.set(String(row.division ?? ""), Number(row.total ?? 0));
  }
  return groups.map((group) => ({
    key: group.key,
    label: group.label,
    bookCount: counts.get(group.key) ?? 0,
  }));
}

/** 只认 `book_groups.key`；查不到返回 null，调用方直接 404，不回查旧分类表。 */
export async function getGroupByKey(
  db: D1Database,
  slug: string,
): Promise<CatalogGroup | null> {
  const groups = await loadBookGroups(db);
  const group = groups.find((entry) => entry.key === slug);
  if (!group) return null;
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS total FROM book_info " +
        "WHERE case_division = ? AND deleted_at IS NULL",
    )
    .bind(slug)
    .first<{total: number}>();
  return {
    key: group.key,
    label: group.label,
    bookCount: Number(row?.total ?? 0),
  };
}
