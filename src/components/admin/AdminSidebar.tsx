import {useEffect, useMemo, useSyncExternalStore, useState} from "react";
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
import {
  bindMenuAccount,
  syncMenuTopLevel,
} from "@/client/menu-open-state";
import {
  getSettingsSection,
  subscribeSettingsSection,
} from "@/client/settings-section-state";
import {
  ADMIN_SETTINGS_SECTIONS,
  settingsSectionFromHash,
} from "@/shared/AdminSettingsNavigation";
import type {AdminMenuItem} from "@/shared/AdminNavigation";
import {ADMIN_API_PAGES, adminApiPageUrl} from "@/shared/AdminApiNavigation";
import {
  ADMIN_WEBHOOK_PAGES,
  adminWebhookPageUrl,
} from "@/shared/AdminWebhookNavigation";
import {ADMIN_MENU_CODES} from "@/shared/Constants";
import {browserAdminPath} from "@/shared/AdminPath";
import AdminAboutDialog from "./AdminAboutDialog";
import AdminMenuItemLink, {hasActiveDescendant} from "./AdminMenuItemLink";
import AdminPublicAccess from "./shared/AdminPublicAccess";
import type {AdminSidebarData} from "./admin-shell-types";
import {UNTITLED_CHANNEL_TITLE} from "./admin-shell-types";

interface Props {
  data: AdminSidebarData;
  onNavigate?: () => void;
}

export interface InjectedSection {
  icon: string;
  id: string;
  nameKey: string;
  url: string;
}

/**
 * 三级子项的注册表：这些子页/分区在数据表里没有对应行，数据树因此没有第三层，
 * 由这里按页面节点注入，侧栏于是读作 集成 → API → 概览/认证/…。
 *
 * 键是**页面节点码**（`ext_permission_nodes.code`）：阶段3 起侧栏由权限树驱动，
 * 节点的身份在权限树里；菜单码仍作 `menu.item.*` 文案键与展开态的索引键。
 * `withPageSections` 用 `item.nodeCode` 查表。
 *
 * 每个域的清单都是各自模块里的唯一数据源（设置是同页锚点，API 与 Webhooks
 * 是真实子页），这里只负责取出来、拼 URL、标活动项——新增一个域就在下面加一行。
 *
 * 导出给侧栏预览复用（ADR-0042 D5）：预览必须画出与真实侧栏相同的第三级子项，
 * 两处各写一份清单必然漂移。
 */
export const SUB_SECTION_BUILDERS: Record<
  string,
  (item: AdminMenuItem) => InjectedSection[]
> = {
  page_settings: (item) => ADMIN_SETTINGS_SECTIONS.map((section) => ({
    icon: section.icon,
    id: section.id,
    nameKey: section.nameKey,
    url: `${item.url}#${section.id}`,
  })),
  page_api: () => ADMIN_API_PAGES.map((page) => ({
    icon: page.icon,
    id: page.id,
    nameKey: page.nameKey,
    url: adminApiPageUrl(page, browserAdminPath()),
  })),
  page_webhooks: () => ADMIN_WEBHOOK_PAGES.map((page) => ({
    icon: page.icon,
    id: page.id,
    nameKey: page.nameKey,
    url: adminWebhookPageUrl(page, browserAdminPath()),
  })),
};

/**
 * 某个节点当前生效的子项：设置看正文实时所在分区（`replaceState` 不触发
 * hashchange，滚动跟随只能走 store），API / Webhooks 看页面传来的
 * `activeSubItem`。节点保持自己的 `menu.item.*` 文案键——`menuEntryLabelKey`
 * 是按 `group_` 前缀判分组的，不看有没有子节点。
 *
 * 这里的比较仍用 `item.id`（菜单码）：`activeSubItem.code` 是页面按
 * `ADMIN_MENU_CODES` 传过来的，两边同属菜单码；注册表那边才用节点码查表。
 */
function activeSectionId(
  item: AdminMenuItem,
  hash: string,
  liveSection: string,
  activeSubItem?: AdminSidebarData["activeSubItem"],
): string {
  if (item.id === ADMIN_MENU_CODES.SETTINGS) {
    // 不在设置页时不高亮任何子项；在设置页时以实时所在分区为准，首帧
    // （store 还没写入）退回 URL hash，再退回第一块，节点因此自动展开。
    if (!item.active) return "";
    return (
      liveSection ||
      settingsSectionFromHash(hash) ||
      ADMIN_SETTINGS_SECTIONS[0]?.id ||
      ""
    );
  }
  return activeSubItem?.code === item.id ? activeSubItem.id : "";
}

export function withPageSections(
  items: AdminMenuItem[],
  hash: string,
  liveSection: string,
  activeSubItem?: AdminSidebarData["activeSubItem"],
): AdminMenuItem[] {
  return items.map((item) => {
    const children = item.children
      ? withPageSections(item.children, hash, liveSection, activeSubItem)
      : undefined;
    // 注册表按页面节点码建键；没有节点的行（首页）查不到，自然不注入。
    const build = SUB_SECTION_BUILDERS[item.nodeCode ?? ""];
    if (!build) return children === undefined ? item : {...item, children};
    const activeId = activeSectionId(item, hash, liveSection, activeSubItem);
    const sections: AdminMenuItem[] = build(item).map((section) => ({
      active: activeId === section.id,
      disabled: false,
      icon: section.icon,
      id: `${item.id}:${section.id}`,
      labelKey: section.nameKey,
      url: section.url,
    }));
    return {...item, children: [...(children ?? []), ...sections]};
  });
}

/** 当前 hash（去掉 #），跟随 hashchange 与 Astro 页面切换更新。 */
function useLocationHash(): string {
  const [hash, setHash] = useState(() =>
    typeof window === "undefined" ? "" : window.location.hash.slice(1),
  );
  useEffect(() => {
    const sync = () => setHash(window.location.hash.slice(1));
    sync();
    window.addEventListener("hashchange", sync);
    document.addEventListener("astro:page-load", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      document.removeEventListener("astro:page-load", sync);
    };
  }, []);
  return hash;
}

export default function AdminSidebar({data, onNavigate}: Props) {
  const {t} = useTranslation();
  const hash = useLocationHash();
  // 首帧就要读到正确展开态：绑定放在渲染前同步做——此刻还没有订阅者，store
  // 的 notify 是静默的；放进 effect 会先闪一帧全收起再展开。
  bindMenuAccount(data.accountKey);
  // 设置页正文滚动时，实时所在分区经 store 同步过来，注入的第三级子项据此
  // 高亮——侧栏与正文是两个岛，URL hash 在 replaceState 下收不到通知。
  // 服务端快照同取 store：本组件只经 client:only 上岛，真服务端渲染走不到；
  // 服务端没有设置页挂着，store 恒为空串，与取固定空串的效果相同。
  const liveSection = useSyncExternalStore(
    subscribeSettingsSection,
    getSettingsSection,
    getSettingsSection,
  );
  const items = useMemo(
    () => withPageSections(data.items, hash, liveSection, data.activeSubItem),
    [data.items, hash, liveSection, data.activeSubItem],
  );
  const topLevelCodes = useMemo(
    () => data.items.map((item) => item.id),
    [data.items],
  );
  const activeTop = items.find(
    (item) => item.active || hasActiveDescendant(item),
  )?.id ?? null;
  // 顶层同时只留一个展开。换页（当前页所在的顶层变化）时改由新页面所在的
  // 顶层展开：用户在这之前手动点开的分组随页面一起翻篇，否则从别处跳进来
  // 会看不到自己在哪。
  useEffect(() => {
    syncMenuTopLevel(activeTop, topLevelCodes);
  }, [activeTop, topLevelCodes]);
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
          {items.map((item) => (
            <AdminMenuItemLink
              depth={0}
              item={item}
              key={item.id}
              onNavigate={onNavigate}
              topLevelCodes={topLevelCodes}
            />
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
