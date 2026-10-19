import {adminUrl} from "./AdminPath";

/**
 * Webhooks 分区的子页清单——主菜单三级子项与页面自身共用这一份，避免两处维护。
 *
 * `icon` 取值必须同时登记在 `MenuIconNames.ts` 与 `AdminMenuItemLink` 的
 * MENU_ICONS（两边由测试守住一一对应）；`nameKey` 走 i18n，不再用硬编码英文名。
 */
export const ADMIN_WEBHOOK_PAGES = [
  {
    icon: "blocks",
    id: "overview",
    nameKey: "webhook.overview",
    path: "webhooks",
  },
  {
    icon: "webhook",
    id: "endpoints",
    nameKey: "webhook.endpoints",
    path: "webhooks/endpoints",
  },
  {
    icon: "flask-conical",
    id: "event_explorer",
    nameKey: "webhook.eventExplorer",
    path: "webhooks/events",
  },
  {
    icon: "activity",
    id: "deliveries",
    nameKey: "webhook.deliveries",
    path: "webhooks/deliveries",
  },
] as const;

export type AdminWebhookPage = typeof ADMIN_WEBHOOK_PAGES[number];
export type AdminWebhookPageId = AdminWebhookPage["id"];

export function adminWebhookPageUrl(
  page: AdminWebhookPage,
  adminPath?: string,
): string {
  return adminUrl(page.path, adminPath);
}
