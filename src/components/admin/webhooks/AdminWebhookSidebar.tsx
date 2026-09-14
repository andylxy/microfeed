import {
  ActivityIcon,
  ArrowLeftIcon,
  BlocksIcon,
  FlaskConicalIcon,
  WebhookIcon,
} from "lucide-react";

import {useTranslation} from "@/client/i18n";
import {
  ADMIN_WEBHOOK_PAGES,
  type AdminWebhookPage,
} from "@/shared/AdminWebhookNavigation";
import AdminAboutDialog from "../AdminAboutDialog";
import type {AdminWebhookSidebarData} from "../admin-shell-types";

interface Props {
  data: AdminWebhookSidebarData;
  onNavigate?: () => void;
}

const pageIcons: Record<AdminWebhookPage["icon"], typeof BlocksIcon> = {
  deliveries: ActivityIcon,
  endpoints: WebhookIcon,
  event_explorer: FlaskConicalIcon,
  overview: BlocksIcon,
};

const pageNameKeys: Record<AdminWebhookPage["id"], string> = {
  overview: "webhook.overview",
  endpoints: "webhook.endpoints",
  event_explorer: "webhook.eventExplorer",
  deliveries: "webhook.deliveries",
};

export default function AdminWebhookSidebar({data, onNavigate}: Props) {
  const {t} = useTranslation();
  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar p-3 text-sidebar-foreground">
      <a
        aria-label={t("nav.goToHome")}
        className="mb-5 inline-flex h-11 items-center gap-2 self-start rounded-xl px-3 text-base font-medium text-sidebar-foreground outline-none transition hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-sidebar-ring/40"
        href={data.backUrl}
        onClick={onNavigate}
      >
        <ArrowLeftIcon aria-hidden="true" className="size-5" />
        <span>{t("common.home")}</span>
      </a>
      <nav className="min-h-0 flex-1" aria-label={t("nav.webhookPages")}>
        <ul className="grid gap-1">
          {ADMIN_WEBHOOK_PAGES.map((page) => {
            const Icon = pageIcons[page.icon];
            const active = page.id === data.activePage;
            return (
              <li key={page.id}>
                <a
                  aria-current={active ? "page" : undefined}
                  className={[
                    "relative flex min-h-11 items-center gap-3 rounded-xl px-3 py-2 text-base font-medium outline-none transition-colors",
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-brand-light"
                      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  ].join(" ")}
                  href={data.pageUrls[page.id]}
                  onClick={onNavigate}
                >
                  <Icon aria-hidden="true" className="size-[18px]" />
                  {t(pageNameKeys[page.id])}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="-mx-3 -mb-3 mt-3 border-t border-sidebar-border p-3">
        <AdminAboutDialog deployment={data.deployment} />
      </div>
    </div>
  );
}
