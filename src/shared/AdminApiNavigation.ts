import {adminUrl} from "./AdminPath";

/**
 * API 分区的子页清单——主菜单三级子项与页面自身共用这一份，避免两处维护。
 *
 * `icon` 取值必须同时登记在 `MenuIconNames.ts` 与 `AdminMenuItemLink` 的
 * MENU_ICONS（两边由测试守住一一对应）；`nameKey` 走 i18n，不再用硬编码英文名。
 */
export const ADMIN_API_PAGES = [
  {
    icon: "blocks",
    id: "overview",
    nameKey: "api.overview",
    path: "api",
  },
  {
    icon: "key-round",
    id: "authentication",
    nameKey: "api.authentication",
    path: "api/auth",
  },
  {
    icon: "code-2",
    id: "explorer",
    nameKey: "api.explorer",
    path: "api/explorer",
  },
  {
    icon: "settings",
    id: "settings",
    nameKey: "api.settings",
    path: "api/settings",
  },
] as const;

export type AdminApiPage = typeof ADMIN_API_PAGES[number];
export type AdminApiPageId = AdminApiPage["id"];

export function adminApiPageUrl(
  page: AdminApiPage,
  adminPath?: string,
): string {
  return adminUrl(page.path, adminPath);
}
