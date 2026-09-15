import {
  THEME_ADMIN_TABS,
  THEME_LIST_SORTS,
  THEME_SEARCH_MAX_LENGTH,
  type ThemeListSort,
  type ThemeListOptions,
  type ThemeAdminTab,
} from "./ThemeContract";
import {AppError} from "../errors";

export function parseThemeAdminTab(
  searchParams: URLSearchParams,
): ThemeAdminTab | null {
  const requested = searchParams.get("tab");
  if (requested === null) return null;
  if (THEME_ADMIN_TABS.includes(requested as ThemeAdminTab)) {
    return requested as ThemeAdminTab;
  }
  throw new AppError("errors.theme.unknownTab");
}

export function parseThemeListOptions(
  searchParams: URLSearchParams,
): ThemeListOptions {
  const q = (searchParams.get("q") ?? "").trim();
  if (q.length > THEME_SEARCH_MAX_LENGTH) {
    throw new AppError("errors.theme.searchTooLong", 400, {
      max: String(THEME_SEARCH_MAX_LENGTH),
    });
  }
  const requestedSort = searchParams.get("sort") ?? "status";
  const sort = THEME_LIST_SORTS.includes(requestedSort as ThemeListSort)
    ? requestedSort as ThemeListSort
    : null;
  if (!sort) throw new AppError("errors.theme.unknownSort");
  const requestedPage = searchParams.get("page") ?? "1";
  if (!/^\d+$/u.test(requestedPage) || Number(requestedPage) < 1) {
    throw new AppError("errors.theme.pageMustBePositive");
  }
  return {page: Number(requestedPage), q, sort};
}
