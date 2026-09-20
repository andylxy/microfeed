import type {
  AdminItemListResponse,
  AdminItemMediaSummary,
  AdminItemSummary,
} from "@/shared/AdminCollections";
import {normalizeAdminItemListLimit} from "@/shared/AdminCollections";
import {STATUSES} from "@/shared/Constants";
import {
  itemQueryForStatusFilter,
  normalizeItemStatusFilter,
} from "@/shared/ItemList";
import {
  encodeItemCursor,
  ITEM_ORDERS,
  ITEM_SORTS,
  resolveItemPagination,
} from "@/shared/ItemPagination";
import {msToRFC3339, rfc3399ToMs} from "@/shared/TimeUtils";
import {
  listCategoryNav,
  listChannelsByGenre,
} from "@/server/feed/extCategory";
import type {CategoryDb} from "@/server/feed/extCategory";

interface AdminItemRow extends Record<string, unknown> {
  book_id: string | null;
  book_title: string | null;
  category_id: string | null;
  created_at: string;
  id: string;
  image: string | null;
  media_file: string | null;
  pub_date: string;
  status: number;
  title: string | null;
  updated_at: string;
}

function mediaSummary(value: unknown): AdminItemMediaSummary | undefined {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const media = parsed as Record<string, unknown>;
    return {
      ...(typeof media.category === "string"
        ? {category: media.category}
        : {}),
      ...(typeof media.durationSecond === "number"
        ? {durationSecond: media.durationSecond}
        : {}),
      ...(typeof media.url === "string" ? {url: media.url} : {}),
    };
  } catch {
    return undefined;
  }
}

function itemSummary(
  row: AdminItemRow,
  categoryNameById: ReadonlyMap<string, string> = new Map(),
): AdminItemSummary {
  const image = String(row.image ?? "").trim();
  const mediaFile = mediaSummary(row.media_file);
  const bookId = row.book_id ? String(row.book_id) : "";
  const bookTitle = row.book_title ? String(row.book_title) : "";
  const categoryId = row.category_id ? String(row.category_id) : "";
  return {
    ...(bookId ? {bookId, bookTitle: bookTitle || "Untitled book"} : {}),
    ...(categoryId
      ? {
        categoryId,
        categoryName: categoryNameById.get(categoryId) ?? "",
      }
      : {}),
    createdAtMs: rfc3399ToMs(row.created_at),
    id: String(row.id),
    ...(image ? {image} : {}),
    ...(mediaFile ? {mediaFile} : {}),
    pubDateMs: rfc3399ToMs(row.pub_date),
    status: Number(row.status),
    title: String(row.title ?? "").trim() || "Untitled",
    updatedAtMs: rfc3399ToMs(row.updated_at),
  };
}

export async function listAdminItems(
  database: D1Database,
  request: Request,
  options: {limit?: unknown} = {},
): Promise<AdminItemListResponse> {
  const searchParams = new URL(request.url).searchParams;
  const statusFilter = normalizeItemStatusFilter(searchParams.get("status"));
  const categoryFilter = (searchParams.get("categoryId") ?? "").trim();
  const bookFilter = (searchParams.get("bookId") ?? "").trim();
  const pagination = resolveItemPagination(searchParams, {
    order: ITEM_ORDERS.DESC,
    sort: ITEM_SORTS.UPDATED_AT,
  });
  const limit = normalizeAdminItemListLimit(options.limit);
  const statusQuery = itemQueryForStatusFilter(statusFilter);
  const statusValue = Object.values(statusQuery)[0] ?? STATUSES.DELETED;
  const where = "status__!=" in statusQuery ? "status != ?" : "status = ?";
  const bindings: unknown[] = [statusValue];
  const requestedCursor = pagination.nextCursor ?? pagination.prevCursor;
  const previousPage = pagination.prevCursor !== undefined;
  const displayDescending = pagination.order === ITEM_ORDERS.DESC;
  const queryDescending = previousPage ? !displayDescending : displayDescending;
  const queryDirection = queryDescending ? "DESC" : "ASC";
  const cursorDirection = previousPage
    ? displayDescending ? ">" : "<"
    : displayDescending ? "<" : ">";
  let cursorClause = "";
  if (requestedCursor !== undefined) {
    try {
      if (pagination.mode === "legacy" && typeof requestedCursor === "number") {
        cursorClause = ` AND ${pagination.column} ${cursorDirection} ?`;
        bindings.push(msToRFC3339(requestedCursor));
      } else if (typeof requestedCursor === "object") {
        cursorClause = ` AND (${pagination.column} ${cursorDirection} ? OR (` +
          `${pagination.column} = ? AND id ${cursorDirection} ?))`;
        const timestamp = msToRFC3339(requestedCursor.timestamp);
        bindings.push(timestamp, timestamp, requestedCursor.id);
      }
    } catch {
      cursorClause = "";
    }
  }
  const idDirection = pagination.mode === "legacy"
    ? previousPage ? "DESC" : "ASC"
    : queryDirection;
  // novel-cms: chapters are filed under a book, and books carry the category, so
  // filtering by category means resolving the chapter's book and comparing its
  // genre. Only added when a category is asked for, leaving the default list
  // query untouched.
  const bookRef = "json_extract(items.data, '$._microfeed.bookId')";
  let bookClause = "";
  if (bookFilter) {
    bookClause = ` AND ${bookRef} = ?`;
    bindings.push(bookFilter);
  }
  let categoryClause = "";
  if (categoryFilter) {
    // `items.` is required: an unqualified `data` inside the subquery resolves
    // to `channels.data` (the inner FROM), which silently matches nothing.
    categoryClause = " AND (SELECT genre FROM channels " +
      "WHERE id = json_extract(items.data, '$._microfeed.bookId')) = ?";
    bindings.push(categoryFilter);
  }
  const categories = (await listCategoryNav(
    database as unknown as CategoryDb,
  )).map((category) => ({
    id: String(category.id),
    name: String(category.name),
  }));
  const categoryNameById = new Map(
    categories.map((category) => [category.id, category.name]),
  );
  // Category → books is the second step of the drill-down; the client shows
  // these under the category pills instead of making a second round trip.
  const books = categoryFilter
    ? (await listChannelsByGenre(
        database as unknown as CategoryDb,
        categoryFilter,
      )).map((book) => ({
        id: String(book.id),
        title: String(book.title ?? ""),
      }))
    : [];
  const result = await database.prepare(`
    SELECT
      id,
      status,
      created_at,
      pub_date,
      updated_at,
      json_extract(data, '$.title') AS title,
      json_extract(data, '$.image') AS image,
      json_extract(data, '$.mediaFile') AS media_file,
      ${bookRef} AS book_id,
      (SELECT json_extract(c.data, '$.title') FROM channels c
        WHERE c.id = ${bookRef}) AS book_title,
      (SELECT c.genre FROM channels c WHERE c.id = ${bookRef}) AS category_id
    FROM items
    WHERE ${where}${cursorClause}${categoryClause}${bookClause}
    ORDER BY ${pagination.column} ${queryDirection}, id ${idDirection}
    LIMIT ?
  `).bind(...bindings, limit + 1).all<AdminItemRow>();
  const hasLookahead = result.results.length > limit;
  const items = result.results.slice(0, limit)
    .map((row) => itemSummary(row, categoryNameById));
  if (previousPage) items.reverse();

  const hasItems = items.length > 0;
  const requestedNextPage = pagination.nextCursor !== undefined;
  const hasNextPage = hasItems && (previousPage || hasLookahead);
  const hasPreviousPage = hasItems && (
    requestedNextPage || (previousPage && hasLookahead)
  );
  const cursorForItem = (item: AdminItemSummary): number | string => {
    const timestamp = item[pagination.timestampKey];
    return pagination.mode === "legacy"
      ? timestamp
      : encodeItemCursor(timestamp, item.id);
  };

  return {
    ...(books.length > 0 ? {books} : {}),
    ...(bookFilter ? {bookFilter} : {}),
    categories,
    ...(categoryFilter ? {categoryFilter} : {}),
    items,
    ...(hasNextPage ? {nextCursor: cursorForItem(items.at(-1)!)} : {}),
    order: pagination.order,
    ...(hasPreviousPage ? {prevCursor: cursorForItem(items[0]!)} : {}),
    sort: pagination.sort,
    statusFilter,
  };
}
