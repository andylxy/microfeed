import {useState} from "react";
import {MenuIcon} from "lucide-react";

import {Button} from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {useTranslation} from "@/client/i18n";
import AdminSidebar from "./AdminSidebar";
import AdminGroupSidebar from "./AdminGroupSidebar";
import AdminSettingsSidebar from "./settings/AdminSettingsSidebar";
import AdminApiSidebar from "./api/AdminApiSidebar";
import AdminAccountSidebar from "./account/AdminAccountSidebar";
import AdminWebhookSidebar from "./webhooks/AdminWebhookSidebar";
import type {
  AdminAccountSidebarData,
  AdminApiSidebarData,
  AdminGroupSidebarData,
  AdminSettingsSidebarData,
  AdminSidebarData,
  AdminWebhookSidebarData,
} from "./admin-shell-types";

interface Props {
  accountSidebar?: AdminAccountSidebarData;
  apiSidebar?: AdminApiSidebarData;
  groupSidebar?: AdminGroupSidebarData;
  settingsSidebar?: AdminSettingsSidebarData;
  sidebar: AdminSidebarData;
  webhookSidebar?: AdminWebhookSidebarData;
}

export default function AdminMobileNavigation({accountSidebar, apiSidebar, groupSidebar, settingsSidebar, sidebar, webhookSidebar}: Props) {
  const {t} = useTranslation();
  const [navigationOpen, setNavigationOpen] = useState(false);

  return (
    <Sheet open={navigationOpen} onOpenChange={setNavigationOpen}>
      <SheetTrigger
        render={
          <Button
            aria-label={t("nav.openAdminNavigation")}
            className="shrink-0 lg:hidden"
            size="icon"
            variant="ghost"
          />
        }
      >
        <MenuIcon aria-hidden="true" />
      </SheetTrigger>
      <SheetContent className="p-0" side="left" showCloseButton={false}>
        <SheetTitle className="sr-only">{t("nav.adminNavigation")}</SheetTitle>
        <SheetDescription className="sr-only">
          {t("nav.adminNavigationDescription")}
        </SheetDescription>
        {accountSidebar ? (
          <AdminAccountSidebar
            data={accountSidebar}
            onNavigate={() => setNavigationOpen(false)}
          />
        ) : apiSidebar ? (
          <AdminApiSidebar
            data={apiSidebar}
            onNavigate={() => setNavigationOpen(false)}
          />
        ) : webhookSidebar ? (
          <AdminWebhookSidebar
            data={webhookSidebar}
            onNavigate={() => setNavigationOpen(false)}
          />
        ) : settingsSidebar ? (
          <AdminSettingsSidebar
            data={settingsSidebar}
            onNavigate={() => setNavigationOpen(false)}
          />
        ) : groupSidebar ? (
          <AdminGroupSidebar
            data={groupSidebar}
            onNavigate={() => setNavigationOpen(false)}
          />
        ) : (
          <AdminSidebar
            data={sidebar}
            onNavigate={() => setNavigationOpen(false)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
