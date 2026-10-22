import type {
  AdminItemListResponse,
  AdminItemMediaSummary,
  AdminItemSummary,
} from "@/shared/AdminCollections";
import {normalizeAdminItemListLimit} from "@/shared/AdminCollections";
import {D1_MAX_BOUND_PARAMS, STATUSES} from "@/shared/Constants";
import {
  itemQueryForStatusFilter,
  normalizeItemStatusFilter,
  normalizeTcmKindFilter,
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
  const tcmKindFilter = normalizeTcmKindFilter(searchParams.get("tcmKind"));
  const pagination = resolveItemPagination(searchParams, {
    order: ITEM_ORDERS.DESC,
    sort: ITEM_SORTS.UPDATED_AT,
  });
  const limit = normalizeAdminItemListLimit(options.limit);
  const statusQuery = itemQueryForStatusFilter(statusFilter);
  const statusValue = Object.values(statusQuery)[0] ?? STATUSES.DELETED;
  const where = "status__!=" in statusQuery ? "status != ?" : "status = ?";
  const bindings: unknown[] = [statusValue];
  // 下方按书分支的语句按 SQL 占位符顺序自行列出参数；游标值单独存放，
  // 分支参数列表就能逐项写出，不用再按下标切分 `bindings`。
  const cursorBindings: unknown[] = [];
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
        cursorBindings.push(msToRFC3339(requestedCursor));
      } else if (typeof requestedCursor === "object") {
        cursorClause = ` AND (${pagination.column} ${cursorDirection} ? OR (` +
          `${pagination.column} = ? AND id ${cursorDirection} ?))`;
        const timestamp = msToRFC3339(requestedCursor.timestamp);
        cursorBindings.push(timestamp, timestamp, requestedCursor.id);
      }
    } catch {
      cursorClause = "";
    }
  }
  bindings.push(...cursorBindings);
  const idDirection = pagination.mode === "legacy"
    ? previousPage ? "DESC" : "ASC"
    : queryDirection;
  // novel-cms: chapters are filed under a book, and books carry the category, so
  // filtering by category means resolving the chapter's book and comparing its
  // genre. Only added when a category is asked for, leaving the default list
  // query untouched.
  // TCM fang (方剂) entries live on the fang container channel but belong to a
  // real book through `_microfeed.sourceBookId` — resolve that first so the
  // admin list shows (and filters by) 伤寒杂病论・(桂林古本) instead of a book
  // literally titled 方剂. Every other item has no sourceBookId and falls back
  // to `_microfeed.bookId` unchanged.
  const bookRef =
    "CASE WHEN json_extract(items.data, '$._microfeed.sourceBookId') IS NOT NULL " +
    "THEN json_extract(items.data, '$._microfeed.sourceBookId') " +
    "ELSE json_extract(items.data, '$._microfeed.bookId') END";
  // Every clause appends its value to `bindings`, so these blocks MUST stay in
  // the same order as the placeholders in the WHERE clause below. They used to
  // push the book first while the SQL asked for the category first, which bound
  // a book id to the genre comparison — a category plus a book then matched
  // nothing at all, and each filter on its own looked perfectly fine.
  // 仅按分类筛选走下面的分片分支，那条语句不含分类比较，这里也不绑定该值。
  const categoryOnly = categoryFilter !== "" && bookFilter === "";
  let categoryClause = "";
  if (categoryFilter && !categoryOnly) {
    // `items.` is required: an unqualified `data` inside the subquery resolves
    // to `channels.data` (the inner FROM), which silently matches nothing.
    categoryClause = ` AND (SELECT genre FROM channels ` +
      `WHERE id = ${bookRef}) = ?`;
    bindings.push(categoryFilter);
  }
  let bookClause = "";
  if (bookFilter) {
    bookClause = ` AND ${bookRef} = ?`;
    bindings.push(bookFilter);
  }
  // tcmKind 索引只在「不带状态等值筛选 + 按 updated_at 排序」时被选用：
  // ix_items_tcm_kind_updated (tcm_kind, updated_at, id) 让过滤与排序共用
  // 一次索引扫描。按 created_at / pub_date 排序时 planner 会选择
  // items_bie_ming (tcm_kind=?) 加临时 B 树，本索引不参与；带具体状态等值
  // 筛选时选 items_status_updated_at，tcm_kind 成为残留条件。仅按分类筛选
  // 的分支以书引用定位 ix_items_book_ref_updated，tcm_kind 同样是分支内的
  // 残留条件，需逐条回表判断。下方语句拼接处给出的上界同样适用于这里：
  // 单本最多 2,964 行（该书全部不匹配 tcm_kind 时即整本）、分类内合计最多
  // 4,127 行。NULL 类别（novel 行）只在「all」下出现。
  let tcmKindClause = "";
  if (tcmKindFilter !== "all") {
    tcmKindClause = " AND tcm_kind = ?";
    bindings.push(tcmKindFilter);
  }
  // 行过滤按「任意携带该 genre 的 channel」匹配，与 channel 的状态、容器标记
  // 无关；下方 `books` 供下拉筛选使用，另带这两个限制。分支 id 因此单独读取，
  // 过滤行集与原查询一致。
  const categoryBookIds = categoryOnly
    ? ((await database.prepare("SELECT id FROM channels WHERE genre = ?")
        .bind(categoryFilter)
        .all<{id: string}>()).results ?? []).map((row) => String(row.id))
    : [];
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
  // 分类 + 书（或仅书）仍走单条语句：书的等值条件用 INDEXED BY 固定
  // ix_items_book_ref_updated（理由同分支）；不带书与分类的查询不强制，
  // planner 可继续用状态索引。
  const fromItems = bookFilter
    ? "items INDEXED BY ix_items_book_ref_updated"
    : "items";
  const selectColumns = `
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
    FROM ${fromItems}`;
  const orderBy =
    `ORDER BY ${pagination.column} ${queryDirection}, id ${idDirection}`;
  // 仅按分类筛选时向每本书各自发送一个分支，每个分支按书引用定位
  // ix_items_book_ref_updated（VACUUM 副本 540,672 字节），读取满 limit + 1 行即
  // 停止。改写成单条语句用 channels 子查询比较时该索引不可用，本地 9,506 行
  // 全表扫描 / 18,395,136 字节（dbstat 4,491 页，平均 1,935 字节/行）；分支后
  // 默认 5 本书 × 21 行 = 105 行 ≈203 KB。`updated_at` 排序由索引顺序给出；
  // `created_at` / `pub_date` 排序时索引只负责按书定位，该书全部匹配行进入临时
  // B 树，上界为单本 2,964 行（按平均 1,935 字节/行约 5.7 MB，`probe-round4.mjs`
  // 计数）、分类内 4,127 行约 8.0 MB（`probe-review6-numbers.mjs`）。每行投影另触发
  // book_title 与 category_id 两个 channels 点查。
  // D1 单条语句最多 D1_MAX_BOUND_PARAMS（100）个绑定参数：每个分支占 3 个固定
  // 参数（status、书 id、分支 LIMIT），另加游标参数（0、1 或 3）与 tcmKind
  // 参数（0 或 1），外层再保留 1 个 LIMIT。书数超过单条上限时按片查询（33 / 16 /
  // 14 本），各片按同一排序键在 TS 里归并，截取前 limit + 1 行。完整代价口径见
  // ADR-0043。
  let result: {results: AdminItemRow[]};
  if (categoryOnly) {
    if (categoryBookIds.length === 0) {
      result = {results: []};
    } else {
      const branchWhere =
        `${where}${cursorClause}${tcmKindClause} AND ${bookRef} = ?`;
      const branchBindings: unknown[] = [
        statusValue,
        ...cursorBindings,
        ...(tcmKindFilter !== "all" ? [tcmKindFilter] : []),
      ];
      const branchParamCount = branchBindings.length + 2;
      const booksPerQuery = Math.floor(
        (D1_MAX_BOUND_PARAMS - 1) / branchParamCount,
      );
      // SQLite 文本排序按 BINARY 比较；排序键与 id 都是 ASCII，JS 的 `<`
      // 与它一致。顺序必须与 SQL 的 ORDER BY 完全相同，各片结果才能直接
      // 归并。NULL 时间戳映射成空字符串，在 ASC 位于最前、DESC 位于最后，与
      // SQLite 处理 NULL 的位置一致。
      const columnSign = queryDescending ? -1 : 1;
      const idSign = idDirection === "DESC" ? -1 : 1;
      const compareText = (left: string, right: string) =>
        left < right ? -1 : left > right ? 1 : 0;
      const compareRows = (left: AdminItemRow, right: AdminItemRow) => {
        const columnOrder = compareText(
          String(left[pagination.column] ?? ""),
          String(right[pagination.column] ?? ""),
        );
        if (columnOrder !== 0) return columnOrder * columnSign;
        return compareText(String(left.id), String(right.id)) * idSign;
      };
      const rows: AdminItemRow[] = [];
      for (
        let start = 0;
        start < categoryBookIds.length;
        start += booksPerQuery
      ) {
        const chunk = categoryBookIds.slice(start, start + booksPerQuery);
        // 分支固定按书引用定位索引：带具体状态筛选、按 created_at / pub_date
        // 排序时，planner 会改选 items_status_created_at / items_status_pub_date，
        // 按状态顺序扫描完整个状态再逐行比对书引用；本地 9,506 行全部是 status = 1，
        // 所以每个分支读取 9,506 行，5 个分支合计 47,530 行为推得值（5 × 9,506），
        // 比旧单条语句还多。INDEXED BY 把计划固定
        // 为按书查找，状态与 tcmKind 成为书内残留条件，上界取上方语句拼接处
        // 那一组数字（单本 2,964 行、分类内 4,127 行）。
        const branches = chunk
          .map(() =>
            `SELECT * FROM (${selectColumns} ` +
            `INDEXED BY ix_items_book_ref_updated WHERE ${branchWhere} ` +
            `${orderBy} LIMIT ?)`
          )
          .join(" UNION ALL ");
        const chunkResult = await database.prepare(
          `SELECT * FROM (${branches}) ${orderBy} LIMIT ?`,
        ).bind(
          ...chunk.flatMap((bookId) => [
            ...branchBindings,
            bookId,
            limit + 1,
          ]),
          limit + 1,
        ).all<AdminItemRow>();
        rows.push(...chunkResult.results);
      }
      result = {results: rows.sort(compareRows).slice(0, limit + 1)};
    }
  } else {
    result = await database.prepare(
      `${selectColumns}
      WHERE ${where}${cursorClause}${categoryClause}${bookClause}${tcmKindClause}
      ${orderBy}
      LIMIT ?`,
    ).bind(...bindings, limit + 1).all<AdminItemRow>();
  }
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
  // One cheap probe for the kind-filter row's visibility. With a composite
  // index on (tcm_kind, …) SQLite scans the index rather than the table, so
  // this stays fast even as the TCM corpus grows.
  const tcmProbe = await database.prepare(
    "SELECT 1 FROM items WHERE tcm_kind IS NOT NULL LIMIT 1",
  ).first();
  const hasTcmItems = tcmProbe !== null;
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
    hasTcmItems,
    items,
    ...(hasNextPage ? {nextCursor: cursorForItem(items.at(-1)!)} : {}),
    order: pagination.order,
    ...(hasPreviousPage ? {prevCursor: cursorForItem(items[0]!)} : {}),
    sort: pagination.sort,
    statusFilter,
    ...(tcmKindFilter !== "all" ? {tcmKindFilter} : {}),
  };
}
