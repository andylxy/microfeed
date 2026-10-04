import {ChevronLeftIcon, ChevronRightIcon} from "lucide-react";

import {Button} from "@/components/ui/button";
import {useTranslation} from "@/client/i18n";
import {DEFAULT_ITEMS_PER_PAGE} from "@/shared/Constants";

/**
 * 管理后台各面板共用的客户端分页，收在一处。
 *
 * 每个 admin 列表/面板都是一次请求取回全部行，再在客户端切片，每页条数来自
 * 设置 → Items「每页条目数」（`webGlobalSettings.itemsPerPage`，作为 prop 往下传）。
 * 切片逻辑和底部分页器原先是每个面板各抄一份；本模块是共享版本。
 *
 * `DEFAULT_ITEMS_PER_PAGE` 只是 prop 缺失时的兜底 —— 正常路径是那个设置项
 * （AGENTS.md「管理后台列表页」）。
 */

export interface PageSlice<Row> {
  /** 要渲染的那一页的行（已夹到合法范围内）。 */
  pageRows: Row[];
  /** 夹到 `0..totalPages - 1` 的请求页码。 */
  safePage: number;
  totalPages: number;
}

/** 把 `rows` 切成第 `page` 页（从 0 开始），并夹到合法范围内。 */
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
  /** 当前页码，从 0 开始。 */
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
  /**
   * 额外的禁用条件（例如「保存进行中」）。翻页按钮在该状态下不可点。
   * 没有它，调用方就只能把整段分页器各抄一份——那正是本组件要消除的重复。
   */
  disabled?: boolean;
}

/** 底部分页器。只有一页时什么都不渲染。 */
export default function AdminPagination({disabled, page, totalPages, onChange}: Props) {
  const {t} = useTranslation();
  if (totalPages <= 1) return null;
  return (
    <nav
      aria-label={t("volumes.paginationAria")}
      className="mt-6 flex items-center justify-center gap-2"
    >
      <Button
        disabled={disabled || page === 0}
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
        disabled={disabled || page >= totalPages - 1}
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
