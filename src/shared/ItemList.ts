import {STATUSES} from "./Constants";
import {
  applyItemPaginationParams,
  ITEM_ORDERS,
  ITEM_SORTS,
  type ItemOrder,
  type ItemSort,
} from "./ItemPagination";

export const ITEM_STATUS_FILTERS = [
  "all",
  "published",
  "unlisted",
  "unpublished",
] as const;

export type ItemStatusFilter = typeof ITEM_STATUS_FILTERS[number];

const ITEM_STATUS_BY_FILTER = {
  published: STATUSES.PUBLISHED,
  unlisted: STATUSES.UNLISTED,
  unpublished: STATUSES.UNPUBLISHED,
} as const;

export function normalizeItemStatusFilter(value: unknown): ItemStatusFilter {
  const normalized = String(value ?? "").trim().toLowerCase();
  return ITEM_STATUS_FILTERS.includes(normalized as ItemStatusFilter)
    ? normalized as ItemStatusFilter
    : "all";
}

// TCM content kinds (spec `.scratch/tcm-import/spec.md` §5.2). Rows carry the
// kind in the `items.tcm_kind` column; "all" clears the filter. Existing
// (non-TCM) rows have a NULL kind and only surface under "all".
export const TCM_KIND_FILTERS = [
  "all",
  "chapter",
  "section",
  "fang",
  "yao",
  "term",
] as const;

export type TcmKindFilter = typeof TCM_KIND_FILTERS[number];

export const TCM_KINDS: readonly Exclude<TcmKindFilter, "all">[] = [
  "chapter",
  "section",
  "fang",
  "yao",
  "term",
];

export function normalizeTcmKindFilter(value: unknown): TcmKindFilter {
  const normalized = String(value ?? "").trim().toLowerCase();
  return TCM_KIND_FILTERS.includes(normalized as TcmKindFilter)
    ? normalized as TcmKindFilter
    : "all";
}

export function itemQueryForStatusFilter(
  value: unknown,
): Record<string, number> {
  const statusFilter = normalizeItemStatusFilter(value);
  if (statusFilter === "all") {
    return {"status__!=": STATUSES.DELETED};
  }

  return {status: ITEM_STATUS_BY_FILTER[statusFilter]};
}

interface ItemsListUrlOptions {
  /** novel-cms category id to keep across paging and sorting. */
  categoryId?: string;
  /** novel-cms book id, for the category → book → chapters drill-down. */
  bookId?: string;
  /** TCM content kind, kept across paging and sorting like the rest. */
  tcmKindFilter?: unknown;
  nextCursor?: number | string;
  order?: ItemOrder;
  prevCursor?: number | string;
  sort?: ItemSort;
  statusFilter?: unknown;
}

export function buildItemsListUrl({
  bookId = "",
  nextCursor,
  order = ITEM_ORDERS.DESC,
  prevCursor,
  sort = ITEM_SORTS.UPDATED_AT,
  statusFilter,
  tcmKindFilter,
  categoryId = "",
}: ItemsListUrlOptions = {}): string {
  const searchParams = new URLSearchParams();
  const normalizedStatus = normalizeItemStatusFilter(statusFilter);
  const normalizedKind = normalizeTcmKindFilter(tcmKindFilter);

  if (normalizedStatus !== "all") {
    searchParams.set("status", normalizedStatus);
  }
  // novel-cms: keep the chosen category in the address so paging, sorting and
  // status changes do not silently drop it.
  if (categoryId) {
    searchParams.set("categoryId", categoryId);
  }
  // A book is chosen inside a category, so both have to travel together or the
  // table would silently widen back to the whole category on the next page.
  if (bookId) {
    searchParams.set("bookId", bookId);
  }
  // TCM kind behaves the same way: changing status or page must not widen the
  // list back to every kind.
  if (normalizedKind !== "all") {
    searchParams.set("tcmKind", normalizedKind);
  }
  applyItemPaginationParams(searchParams, {
    nextCursor,
    order,
    prevCursor,
    sort,
  });

  return `?${searchParams.toString()}`;
}
