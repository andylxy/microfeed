import {ChevronLeftIcon, ChevronRightIcon} from "lucide-react";

import {Button} from "@/components/ui/button";
import {useTranslation} from "@/client/i18n";
import {DEFAULT_ITEMS_PER_PAGE} from "@/shared/Constants";

/**
 * Client-side paging for admin boards, in one place.
 *
 * Every admin list/board loads its rows in a single request and slices them
 * client-side, with the page size coming from Settings → Items "每页条目数"
 * (`webGlobalSettings.itemsPerPage`, passed down as a prop). Both the slice and
 * the footer pager were copied per board; this module is the shared version.
 *
 * `DEFAULT_ITEMS_PER_PAGE` is only a fallback for when the prop is absent — the
 * normal path is the setting (AGENTS.md「管理后台列表页」).
 */

export interface PageSlice<Row> {
  /** The rows to render for the requested page (clamped into range). */
  pageRows: Row[];
  /** The requested page clamped to `0..totalPages - 1`. */
  safePage: number;
  totalPages: number;
}

/** Slice `rows` into the page `page` (zero-based), clamped into range. */
export function paginate<Row>(
  rows: Row[],
  itemsPerPage: number | undefined,
  page: number,
): PageSlice<Row> {
  const pageSize = Math.max(1, itemsPerPage ?? DEFAULT_ITEMS_PER_PAGE);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  return {
    pageRows: rows.slice(safePage * pageSize, (safePage + 1) * pageSize),
    safePage,
    totalPages,
  };
}

interface Props {
  /** Zero-based current page. */
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
}

/** Footer pager. Renders nothing when there is only one page. */
export default function AdminPagination({page, totalPages, onChange}: Props) {
  const {t} = useTranslation();
  if (totalPages <= 1) return null;
  return (
    <nav
      aria-label={t("volumes.paginationAria")}
      className="mt-6 flex items-center justify-center gap-2"
    >
      <Button
        disabled={page === 0}
        onClick={() => onChange(Math.max(0, page - 1))}
        size="sm"
        type="button"
        variant="outline"
      >
        <ChevronLeftIcon aria-hidden="true" />
        {t("volumes.previous")}
      </Button>
      <span className="text-sm text-muted-foreground">
        {t("volumes.pageIndicator", {current: page + 1, total: totalPages})}
      </span>
      <Button
        disabled={page >= totalPages - 1}
        onClick={() => onChange(Math.min(totalPages - 1, page + 1))}
        size="sm"
        type="button"
        variant="outline"
      >
        {t("volumes.next")}
        <ChevronRightIcon aria-hidden="true" />
      </Button>
    </nav>
  );
}
