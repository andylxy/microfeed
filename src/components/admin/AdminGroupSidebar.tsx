import {ArrowLeftIcon} from "lucide-react";

import {useTranslation} from "@/client/i18n";
import {menuGroupLabelKey} from "@/shared/AdminNavigation";
import AdminAboutDialog from "./AdminAboutDialog";
import AdminMenuItemLink from "./AdminMenuItemLink";
import type {AdminGroupSidebarData} from "./admin-shell-types";

interface Props {
  data: AdminGroupSidebarData;
  onNavigate?: () => void;
}

/**
 * The sidebar shown while inside a menu group: a "back to home" link, the group
 * heading, then the group's pages. It mirrors `AdminSettingsSidebar`'s shape so
 * the two read the same, but its entries link to sibling pages — the menu is
 * data, so the children come straight from `ext_menu`.
 */
export default function AdminGroupSidebar({data, onNavigate}: Props) {
  const {t} = useTranslation();
  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar p-3 text-sidebar-foreground">
      <a
        aria-label={t("nav.goToHome")}
        className="mb-4 inline-flex h-11 items-center gap-2 self-start rounded-xl px-3 text-base font-medium text-sidebar-foreground outline-none transition hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-sidebar-ring/40"
        href={data.backUrl}
        onClick={onNavigate}
      >
        <ArrowLeftIcon aria-hidden="true" className="size-5" />
        <span>{t("common.home")}</span>
      </a>

      <p className="mb-2 px-3 text-xs font-medium tracking-wide text-sidebar-foreground/60 uppercase">
        {t(menuGroupLabelKey(data.groupId))}
      </p>

      <nav
        aria-label={t("nav.adminNavigation")}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <ul className="grid gap-1">
          {data.items.map((item) => (
            <AdminMenuItemLink item={item} key={item.id} onNavigate={onNavigate} />
          ))}
        </ul>
      </nav>

      <div className="-mx-3 -mb-3 mt-3 border-t border-sidebar-border p-3">
        <AdminAboutDialog deployment={data.deployment} />
      </div>
    </div>
  );
}
