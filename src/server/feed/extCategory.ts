import {randomShortUUID} from "@/shared/StringUtils";

/**
 * Read model for a novel-cms category (题材分类).
 *
 * Mirrors the `ext_category` table from migration 0023. `bookCount` is only
 * populated by {@link listCategoryNav} (books joined via channels.genre).
 */
export interface Category {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  sort: number;
  visible: boolean;
  createdAt: string;
  bookCount?: number;
}

/** Minimal D1-shaped database port. Real D1 satisfies this structurally, and a
 *  fake implements it for unit tests — same pattern as extContentAudit. */
export interface CategoryDbPreparedStatement {
  bind(...values: unknown[]): CategoryDbPreparedStatement;
  run(): Promise<CategoryDbRunResult>;
  all(): Promise<CategoryDbAllResult>;
  first(): Promise<Record<string, unknown> | null>;
}

export interface CategoryDbRunResult {
  success: boolean;
}

export interface CategoryDbAllResult {
  results: Record<string, unknown>[];
}

export interface CategoryDb {
  prepare(query: string): CategoryDbPreparedStatement;
}

export interface CategoryInput {
  name: string;
  slug?: string;
  parentId?: string | null;
  sort?: number;
  visible?: boolean;
}

/** A book (channel) summary used by the public category page. */
export interface ChannelBookSummary {
  id: string;
  title: string;
  image: string;
  link: string;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "category";
}

function rowToCategory(row: Record<string, unknown>): Category {
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    parentId: row.parent_id == null ? null : String(row.parent_id),
    sort: Number(row.sort ?? 0),
    visible: Boolean(row.visible),
    createdAt: String(row.created_at ?? ""),
    ...(row.book_count != null ? {bookCount: Number(row.book_count)} : {}),
  };
}

export async function listCategories(db: CategoryDb): Promise<Category[]> {
  const result = await db.prepare(
    "SELECT id, name, slug, parent_id, sort, visible, created_at " +
      "FROM ext_category ORDER BY sort ASC, created_at ASC",
  ).all();
  return result.results.map(rowToCategory);
}

export async function getCategory(
  db: CategoryDb,
  id: string,
): Promise<Category | null> {
  const row = await db.prepare(
    "SELECT id, name, slug, parent_id, sort, visible, created_at " +
      "FROM ext_category WHERE id = ?",
  ).bind(id).first();
  return row ? rowToCategory(row) : null;
}

export async function getCategoryBySlug(
  db: CategoryDb,
  slug: string,
): Promise<Category | null> {
  const row = await db.prepare(
    "SELECT id, name, slug, parent_id, sort, visible, created_at " +
      "FROM ext_category WHERE slug = ?",
  ).bind(slug).first();
  return row ? rowToCategory(row) : null;
}

export async function createCategory(
  db: CategoryDb,
  input: CategoryInput,
): Promise<Category> {
  const id = randomShortUUID();
  const slug = input.slug?.trim() || slugify(input.name);
  const parentId = input.parentId ?? null;
  const sort = input.sort ?? 0;
  const visible = input.visible ?? true;
  const createdAt = Date.now();
  await db.prepare(
    "INSERT INTO ext_category (id, name, slug, parent_id, sort, visible, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, input.name, slug, parentId, sort, visible ? 1 : 0, createdAt).run();
  const created = await getCategory(db, id);
  if (!created) throw new Error("extCategory: failed to read back created row");
  return created;
}

export async function updateCategory(
  db: CategoryDb,
  id: string,
  input: Partial<CategoryInput>,
): Promise<Category | null> {
  const existing = await getCategory(db, id);
  if (!existing) return null;
  const name = input.name ?? existing.name;
  const slug = input.slug?.trim() || existing.slug;
  const parentId = input.parentId === undefined ? existing.parentId : input.parentId;
  const sort = input.sort ?? existing.sort;
  const visible = input.visible ?? existing.visible;
  await db.prepare(
    "UPDATE ext_category SET name = ?, slug = ?, parent_id = ?, sort = ?, visible = ? " +
      "WHERE id = ?",
  ).bind(
    name,
    slug,
    parentId,
    sort,
    visible ? 1 : 0,
    id,
  ).run();
  return getCategory(db, id);
}

export async function deleteCategory(
  db: CategoryDb,
  id: string,
): Promise<boolean> {
  const result = await db.prepare(
    "DELETE FROM ext_category WHERE id = ?",
  ).bind(id).run();
  return result.success;
}

/** Persist an explicit display order. `ids` is the full category id list, in
 *  the desired top-to-bottom sequence; each id receives its 0-based index. */
export async function reorderCategories(
  db: CategoryDb,
  ids: string[],
): Promise<void> {
  for (let i = 0; i < ids.length; i++) {
    await db.prepare(
      "UPDATE ext_category SET sort = ? WHERE id = ?",
    ).bind(i, ids[i]).run();
  }
}

export async function setCategoryVisible(
  db: CategoryDb,
  id: string,
  visible: boolean,
): Promise<Category | null> {
  return updateCategory(db, id, {visible});
}

/**
 * Public category navigation: visible categories that have at least one
 * published book, aggregated by `channels.genre`, with live book counts.
 * Powers the "分类导航" section on the home template.
 */
export async function listCategoryNav(db: CategoryDb): Promise<Category[]> {
  const result = await db.prepare(
    "SELECT c.id, c.name, c.slug, c.parent_id, c.sort, c.visible, c.created_at, " +
      "COUNT(ch.id) AS book_count " +
      "FROM ext_category c " +
      "LEFT JOIN channels ch ON ch.genre = c.id AND ch.status = 'published' " +
      "WHERE c.visible = 1 " +
      "GROUP BY c.id " +
      "HAVING book_count > 0 " +
      "ORDER BY c.sort ASC, c.created_at ASC",
  ).all();
  return result.results.map(rowToCategory);
}

/** Books (channels) assigned to a given genre (category id), for the public
 *  category page. Only published channels are returned. */
export async function listChannelsByGenre(
  db: CategoryDb,
  genre: string,
): Promise<ChannelBookSummary[]> {
  const result = await db.prepare(
    "SELECT id, data FROM channels WHERE genre = ? AND status = 'published'",
  ).bind(genre).all();
  return result.results.map((row) => {
    const data = safeParseJson(row.data);
    return {
      id: String(row.id),
      title: typeof data.title === "string" ? data.title : "",
      image: typeof data.image === "string" ? data.image : "",
      link: typeof data.link === "string" ? data.link : "",
    };
  });
}

function safeParseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Pure helper that derives the `channels.genre` mirror value from a channel's
 * parsed `data` JSON. The primary category id lives in `data._microfeed.genre`
 * (the SSOT); the `channels.genre` column is only a denormalized, queryable
 * copy. Returns null when the channel has no `_microfeed` pocket, so non-novel
 * channels are left untouched. Called from FeedDb on every channel write.
 */
export function extractGenreFromChannelData(
  data: Record<string, unknown> | null | undefined,
): string | null {
  if (!data) return null;
  const microfeed = data._microfeed;
  if (microfeed == null || typeof microfeed !== "object") return null;
  const genre = (microfeed as Record<string, unknown>).genre;
  if (genre == null) return null;
  return typeof genre === "string" ? genre : String(genre);
}
