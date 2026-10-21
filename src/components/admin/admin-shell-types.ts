import type {AdminMenuItem} from "@/shared/AdminNavigation";
import type {AdminAccountSection} from "@/shared/AdminAccountNavigation";

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
  /**
   * Scopes the menu tree's expand state in `localStorage` to one account
   * (plan §2.2): the auth user id, falling back to the Cloudflare Access
   * email. Absent only on an unprotected dashboard, where the shared key is
   * all there is.
   */
  accountKey?: string;
  /**
   * 当前页处于某个入口的第三级子项上（如 API → 认证）。主侧栏据此给对应
   * 子项标红——这些子项在权限树里没有对应节点，位置只能由页面告知。
   */
  activeSubItem?: {
    /** 所属菜单行的 code，如 `api` / `webhooks`。 */
    code: string;
    /** 子项 id，如 `overview` / `endpoints`。 */
    id: string;
  };
  channel: AdminChannelSummary;
  deployment: AdminDeploymentSummary;
  items: AdminMenuItem[];
  newItem: {
    disabled: boolean;
    url: string;
  };
  publicLinks: AdminPublicLinks;
}

export interface AdminAccountSidebarData {
  activeSection?: AdminAccountSection["id"];
  backUrl: string;
  deployment: AdminDeploymentSummary;
  sectionsUrl: string;
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
