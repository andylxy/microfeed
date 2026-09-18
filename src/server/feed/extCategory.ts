import {STATUSES} from "@/shared/Constants";
import {PUBLIC_URLS, randomShortUUID} from "@/shared/StringUtils";
// The plain data shapes live in src/shared so the admin React app can use them
// without importing from src/server (a hard boundary in this repo). Re-exported
// here so existing server-side imports keep working unchanged.
import type {
  Category,
  CategoryInput,
  ChannelBookSummary,
} from "@/shared/ExtCategory";

export type {Category, CategoryInput, ChannelBookSummary};

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

/** Lightweight `{id, title}` list of published books (channels) for use in
 *  admin dropdowns that let a chapter be assigned to a book. */
export async function listBookOptions(
  db: CategoryDb,
): Promise<Array<{id: string; title: string}>> {
  const result = await db.prepare(
    "SELECT id, data FROM channels WHERE status = ? ORDER BY created_at ASC",
  ).bind(STATUSES.PUBLISHED).all();
  return result.results.map((row) => {
    const data = safeParseJson(row.data);
    return {
      id: String(row.id),
      title: typeof data.title === "string" ? data.title : "未命名作品",
    };
  });
}

/** Public book cards for the shelf/home page. A microfeed site has one primary
 * feed, but novel samples and future multi-book channels can still be listed
 * from the published channels table without changing the feed contract. */
export async function listPublishedBookSamples(
  db: CategoryDb,
): Promise<ChannelBookSummary[]> {
  const result = await db.prepare(
    "SELECT id, data, genre FROM channels " +
      "WHERE status = ? ORDER BY is_primary DESC, created_at ASC",
  ).bind(STATUSES.PUBLISHED).all();
  const catRows = await db.prepare(
    "SELECT id, name FROM ext_category WHERE visible = 1",
  ).all();
  const nameById = new Map(
    catRows.results.map((r) => [String(r.id), String(r.name)]),
  );
  return result.results.map((row) => {
    const data = safeParseJson(row.data);
    const authors = Array.isArray(data.authors) ? data.authors : [];
    const author = authors[0] && typeof authors[0] === "object"
      ? (authors[0] as Record<string, unknown>).name
      : undefined;
    const microfeed = data._microfeed && typeof data._microfeed === "object"
      ? data._microfeed as Record<string, unknown>
      : {};
    return {
      id: String(row.id),
      title: typeof data.title === "string" ? data.title : "未命名作品",
      image: typeof data.image === "string"
        ? data.image
        : typeof data.icon === "string" ? data.icon : "",
      link: typeof data.link === "string" ? data.link : "/",
      ...(typeof author === "string" ? {author} : {}),
      ...(typeof data.description === "string"
        ? {description: data.description.replace(/<[^>]+>/g, "").trim()}
        : {}),
      ...(typeof microfeed.serialStatus === "string"
        ? {serialStatus: microfeed.serialStatus}
        : {}),
      ...(typeof microfeed.wordCount === "number"
        ? {wordCount: String(microfeed.wordCount)}
        : {}),
      ...(typeof row.genre === "string"
        ? {genre: row.genre, categoryName: nameById.get(row.genre) ?? ""}
        : {}),
    };
  });
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
 * Public category navigation: every visible category, aggregated by
 * `channels.genre`, with live book counts. Powers the "分类导航" section on
 * the home template.
 *
 * A category is listed even when it currently holds no book. `HAVING
 * book_count > 0` used to drop every category that had no published book
 * assigned, which silently emptied the whole nav on sites whose channel had
 * not been given a genre yet.
 *
 * `channels.status` stores the numeric `STATUSES` value, not the status name,
 * so the join must compare against the number — comparing to `'published'`
 * matched nothing and made every count zero.
 */
export async function listCategoryNav(db: CategoryDb): Promise<Category[]> {
  const result = await db.prepare(
    "SELECT c.id, c.name, c.slug, c.parent_id, c.sort, c.visible, c.created_at, " +
      "COUNT(ch.id) AS book_count " +
      "FROM ext_category c " +
      "LEFT JOIN channels ch ON ch.genre = c.id AND ch.status = ? " +
      "WHERE c.visible = 1 " +
      "GROUP BY c.id " +
      "ORDER BY c.sort ASC, c.created_at ASC",
  ).bind(STATUSES.PUBLISHED).all();
  return result.results.map(rowToCategory);
}

/** Books (channels) assigned to a given genre (category id), for the public
 *  category page. Only published channels are returned. */
export async function listChannelsByGenre(
  db: CategoryDb,
  genre: string,
): Promise<ChannelBookSummary[]> {
  const result = await db.prepare(
    // `channels.status` is the numeric STATUSES value, not the status name.
    "SELECT id, data FROM channels WHERE genre = ? AND status = ?",
  ).bind(genre, STATUSES.PUBLISHED).all();
  return result.results.map((row) => {
    const data = safeParseJson(row.data);
    const authors = Array.isArray(data.authors) ? data.authors : [];
    const author = authors[0] && typeof authors[0] === "object"
      ? (authors[0] as Record<string, unknown>).name
      : undefined;
    const microfeed = data._microfeed && typeof data._microfeed === "object"
      ? data._microfeed as Record<string, unknown>
      : {};
    return {
      id: String(row.id),
      title: typeof data.title === "string" ? data.title : "",
      image: typeof data.image === "string" ? data.image : "",
      link: typeof data.link === "string" ? data.link : "",
      ...(typeof author === "string" ? {author} : {}),
      ...(typeof data.description === "string"
        ? {description: data.description.replace(/<[^>]+>/g, "").trim()}
        : {}),
      ...(typeof microfeed.serialStatus === "string"
        ? {serialStatus: microfeed.serialStatus}
        : {}),
      ...(typeof microfeed.wordCount === "number"
        ? {wordCount: String(microfeed.wordCount)}
        : {}),
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

/** A single book (channel) by id, for the public book detail page. Returns the
 *  same summary shape as the shelf/category listings, plus the raw `_microfeed`
 *  pocket so the detail header can render genre/tags/serial status. */
export async function getBookById(
  db: CategoryDb,
  id: string,
): Promise<ChannelBookSummary | null> {
  const row = await db.prepare(
    "SELECT id, data, genre FROM channels WHERE id = ? AND status = ?",
  ).bind(id, STATUSES.PUBLISHED).first();
  if (!row) return null;
  // The detail page renders the genre as a tag. `channels.genre` holds the
  // category *id*, so resolve the display name here — otherwise the raw id
  // (e.g. `cat_x1`) leaks into the tag list.
  let categoryName = "";
  if (typeof row.genre === "string" && row.genre) {
    const category = await db.prepare(
      "SELECT name FROM ext_category WHERE id = ?",
    ).bind(row.genre).first();
    if (category && typeof category.name === "string") {
      categoryName = category.name;
    }
  }
  const data = safeParseJson(row.data);
  const authors = Array.isArray(data.authors) ? data.authors : [];
  const author = authors[0] && typeof authors[0] === "object"
    ? (authors[0] as Record<string, unknown>).name
    : undefined;
  const microfeed = data._microfeed && typeof data._microfeed === "object"
    ? data._microfeed as Record<string, unknown>
    : {};
  return {
    id: String(row.id),
    title: typeof data.title === "string" ? data.title : "未命名作品",
    image: typeof data.image === "string"
      ? data.image
      : typeof data.icon === "string" ? data.icon : "",
    link: typeof data.link === "string" ? data.link : "/",
    ...(typeof author === "string" ? {author} : {}),
    ...(typeof data.description === "string"
      ? {description: data.description.replace(/<[^>]+>/g, "").trim()}
      : {}),
    ...(typeof microfeed.serialStatus === "string"
      ? {serialStatus: microfeed.serialStatus}
      : {}),
    ...(typeof microfeed.wordCount === "number"
      ? {wordCount: String(microfeed.wordCount)}
      : {}),
    ...(typeof row.genre === "string" ? {genre: row.genre} : {}),
    ...(categoryName ? {categoryName} : {}),
    microfeed,
  };
}

/**
 * Every published chapter that belongs to a book, resolved by the
 * `_microfeed.bookId` tag rather than the primary feed's paged item window.
 * The public feed only returns the most recent page of items, so a book with
 * more chapters than `itemsPerPage` would otherwise show a truncated catalog.
 * Returns items shaped like the public feed (top-level `_microfeed`, `title`,
 * and a `web_url` built with the same algorithm the reader route uses).
 */
export async function getBookChapters(
  db: CategoryDb,
  bookId: string,
  baseUrl: string,
): Promise<Array<Record<string, any>>> {
  // D1's SQL engine rejects the nested `json_extract(data, '$._microfeed.bookId')`
  // path form (it returns SQLITE_ERROR 7500 over the wrangler CLI, and the same
  // shape is risky on the worker edge too), so we load the published items and
  // resolve the `_microfeed.bookId` membership + `chapterNo` ordering in
  // JavaScript. A novel-cms site's item table is bounded by design (chapters),
  // so the full scan is both safe and portable across sqlite builds.
  const result = await db.prepare(
    "SELECT id, status, data, pub_date, updated_at FROM items WHERE status = ?",
  ).bind(STATUSES.PUBLISHED).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  const tagged: Array<{
    row: Record<string, unknown>;
    chapterNo: number;
    microfeed: Record<string, unknown>;
    data: Record<string, unknown>;
  }> = [];
  for (const row of rows) {
    const data = safeParseJson(row.data) ?? {};
    const microfeed = data._microfeed && typeof data._microfeed === "object"
      ? data._microfeed as Record<string, unknown>
      : {};
    if (microfeed.bookId !== bookId) continue;
    const rawNo = microfeed.chapterNo;
    const chapterNo = typeof rawNo === "number"
      ? rawNo
      : Number.isFinite(Number(rawNo)) ? Number(rawNo) : 0;
    tagged.push({row, chapterNo, microfeed, data});
  }
  tagged.sort((a, b) => a.chapterNo - b.chapterNo);
  return tagged.map(({row, microfeed, data}) => {
    const id = String(row.id);
    const title = typeof data.title === "string" ? data.title : "未命名章节";
    const pubDate = typeof row.pub_date === "string" ? row.pub_date : "";
    const shortDate = pubDate ? pubDate.slice(0, 10) : "";
    return {
      id,
      status: row.status,
      ...data,
      _microfeed: {
        ...microfeed,
        web_url: PUBLIC_URLS.webItem(id, title, baseUrl),
        ...(shortDate ? {date_published_short: shortDate} : {}),
      },
    };
  });
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
