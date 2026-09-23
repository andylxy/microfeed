import {Globe2Icon, PlusIcon} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {buttonVariants} from "@/components/ui/button";
import {cn} from "@/lib/utils";
import {useTranslation} from "@/client/i18n";
import {ADMIN_MENU_CODES} from "@/shared/Constants";
import AdminAboutDialog from "./AdminAboutDialog";
import AdminMenuItemLink from "./AdminMenuItemLink";
import AdminPublicAccess from "./shared/AdminPublicAccess";
import type {AdminSidebarData} from "./admin-shell-types";
import {UNTITLED_CHANNEL_TITLE} from "./admin-shell-types";

interface Props {
  data: AdminSidebarData;
  onNavigate?: () => void;
}

export default function AdminSidebar({data, onNavigate}: Props) {
  const {t} = useTranslation();
  const channelTitle = data.channel.title === UNTITLED_CHANNEL_TITLE
    ? t("channel.untitled")
    : data.channel.title;
  // Home is always present and is public, so "only the home entry" means the
  // account holds no permission any menu binds — surface that rather than
  // leaving an unexplained one-item sidebar.
  const onlyHome = data.items.length === 1 &&
    data.items[0]?.id === ADMIN_MENU_CODES.ADMIN_HOME;

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="p-3">
        <Dialog>
          <DialogTrigger
            render={
              <button
                aria-label={t("nav.openPublicAccess", {title: channelTitle})}
                className="group flex min-h-16 w-full items-center gap-3 rounded-[var(--radius-card)] border border-sidebar-border bg-sidebar px-3 py-2.5 text-left shadow-xs outline-none transition hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-sidebar-ring/40"
                type="button"
              />
            }
          >
            {data.channel.imageUrl ? (
              <img
                alt=""
                aria-hidden="true"
                className="size-10 shrink-0 rounded-[10px] border border-sidebar-border object-cover"
                src={data.channel.imageUrl}
              />
            ) : (
              <span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-brand-light/15 font-bold text-brand-dark ring-1 ring-brand-light/25 dark:text-brand-light">
                {channelTitle.slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="line-clamp-2 min-w-0 flex-1 text-sm leading-5 font-semibold">
              {channelTitle}
            </span>
            <Globe2Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          </DialogTrigger>
          <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto p-0 sm:max-w-3xl">
            <DialogTitle className="sr-only">
              {t("nav.publicAccess", {title: channelTitle})}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {t("nav.publicAccessDescription")}
            </DialogDescription>
            <AdminPublicAccess
              className="border-0 shadow-none"
              links={data.publicLinks}
            />
          </DialogContent>
        </Dialog>
      </div>

      <div className="px-3 pb-2">
        {data.newItem.disabled ? (
          <span
            aria-disabled="true"
            className={cn(
              buttonVariants({size: "lg"}),
              "w-full cursor-not-allowed !text-white opacity-45",
            )}
          >
            <PlusIcon aria-hidden="true" />
            {t("nav.addNewItem")}
          </span>
        ) : (
          <a
            className={cn(
              buttonVariants({size: "lg"}),
              "w-full !text-white hover:!text-white",
            )}
            data-astro-prefetch="hover"
            href={data.newItem.url}
            onClick={onNavigate}
          >
            <PlusIcon aria-hidden="true" />
            {t("nav.addNewItem")}
          </a>
        )}
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-3" aria-label={t("nav.adminNavigation")}>
        <ul className="grid gap-1">
          {data.items.map((item) => (
            <AdminMenuItemLink item={item} key={item.id} onNavigate={onNavigate} />
          ))}
        </ul>
        {onlyHome && (
          <p className="mt-3 rounded-xl border border-sidebar-border bg-sidebar-accent px-3 py-2 text-xs leading-5 text-sidebar-foreground/70">
            {t("menu.noPermissions")}
          </p>
        )}
      </nav>

      <div className="border-t border-sidebar-border p-3">
        <AdminAboutDialog deployment={data.deployment} />
      </div>
    </div>
  );
}
