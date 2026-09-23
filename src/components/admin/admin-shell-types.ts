import type {AdminMenuItem} from "@/shared/AdminNavigation";
import type {AdminSettingsSection} from "@/shared/AdminSettingsNavigation";
import type {AdminApiPageId} from "@/shared/AdminApiNavigation";
import type {AdminAccountSection} from "@/shared/AdminAccountNavigation";
import type {AdminWebhookPageId} from "@/shared/AdminWebhookNavigation";

export interface AdminBreadcrumb {
  childName?: string;
  kind?: "back";
  name: string;
  url: string;
}

export interface AdminChannelSummary {
  imageUrl?: string;
  title: string;
}

export interface AdminPublicLinks {
  json: string;
  rss: string;
  website: string;
}

export interface AdminIdentitySummary {
  cloudflareAccessDetected: boolean;
  cloudflareAccessEmail?: string;
  builtInEmail?: string;
}

export interface AdminDeploymentSummary {
  deployedAt: string;
  protected: boolean;
  productionWorkerName?: string;
  sourceCommit?: string;
}

export interface AdminSidebarData {
  channel: AdminChannelSummary;
  deployment: AdminDeploymentSummary;
  items: AdminMenuItem[];
  newItem: {
    disabled: boolean;
    url: string;
  };
  publicLinks: AdminPublicLinks;
}

/**
 * The sub-sidebar shown inside a menu group. `groupId` is the group's
 * `ext_menu.code` (e.g. `group_content`); its label resolves through
 * `menu.group.*`, and `items` are the group's already-filtered children.
 */
export interface AdminGroupSidebarData {
  backUrl: string;
  deployment: AdminDeploymentSummary;
  groupId: string;
  items: AdminMenuItem[];
}

export interface AdminSettingsSidebarData {
  activeSection?: AdminSettingsSection["id"];
  backUrl: string;
  deployment: AdminDeploymentSummary;
  sectionsUrl: string;
}

export interface AdminAccountSidebarData {
  activeSection?: AdminAccountSection["id"];
  backUrl: string;
  deployment: AdminDeploymentSummary;
  sectionsUrl: string;
}

export interface AdminApiSidebarData {
  activePage: AdminApiPageId;
  backUrl: string;
  deployment: AdminDeploymentSummary;
  pageUrls: Record<AdminApiPageId, string>;
}

export interface AdminWebhookSidebarData {
  activePage: AdminWebhookPageId;
  backUrl: string;
  deployment: AdminDeploymentSummary;
  pageUrls: Record<AdminWebhookPageId, string>;
}

/**
 * English placeholder returned when a channel has no title yet. This module is
 * also imported by the server-rendered admin shell, so it stays free of client
 * i18n imports; renderers translate this value via `channel.untitled`.
 */
export const UNTITLED_CHANNEL_TITLE = "Untitled channel";

export function adminChannelSummary(
  title: unknown,
  imageUrl?: string | null,
): AdminChannelSummary {
  const normalizedTitle = typeof title === "string" && title.trim()
    ? title.trim()
    : UNTITLED_CHANNEL_TITLE;
  return {
    imageUrl: typeof imageUrl === "string" && imageUrl.trim()
      ? imageUrl.trim()
      : undefined,
    title: normalizedTitle,
  };
}
