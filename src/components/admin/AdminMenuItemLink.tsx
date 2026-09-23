import {
  BookIcon,
  Code2Icon,
  FileCode2Icon,
  FileTextIcon,
  HistoryIcon,
  HomeIcon,
  LayersIcon,
  ListIcon,
  PencilIcon,
  SettingsIcon,
  ShieldCheckIcon,
  TagsIcon,
  UploadIcon,
  UsersIcon,
  WebhookIcon,
} from "lucide-react";

import {useTranslation} from "@/client/i18n";
import {menuEntryLabelKey, type AdminMenuItem} from "@/shared/AdminNavigation";

interface Props {
  item: AdminMenuItem;
  onNavigate?: () => void;
}

/**
 * Menu icons are named in the data (`ext_menu.icon`, e.g. "book"), so this
 * resolves a name to a component instead of keying off a menu id. An unknown
 * name falls back rather than rendering an empty slot.
 */
const MENU_ICONS: Record<string, typeof HomeIcon> = {
  book: BookIcon,
  "code-2": Code2Icon,
  "file-code-2": FileCode2Icon,
  "file-text": FileTextIcon,
  history: HistoryIcon,
  home: HomeIcon,
  layers: LayersIcon,
  list: ListIcon,
  pencil: PencilIcon,
  "shield-check": ShieldCheckIcon,
  settings: SettingsIcon,
  tags: TagsIcon,
  upload: UploadIcon,
  users: UsersIcon,
  webhook: WebhookIcon,
};

const FALLBACK_MENU_ICON = ListIcon;

/** One row: a link, or a disabled span while onboarding is incomplete. */
export default function AdminMenuItemLink({item, onNavigate}: Props) {
  const {t} = useTranslation();
  const Icon = (item.icon && MENU_ICONS[item.icon]) || FALLBACK_MENU_ICON;
  const classes = [
    "relative flex min-h-11 items-center gap-3 rounded-xl px-3 py-2 text-base font-medium outline-none transition-colors",
    item.active
      ? "bg-brand-light/12 text-brand-dark before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-brand-light dark:text-brand-light"
      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground",
    item.disabled ? "cursor-not-allowed opacity-45" : "",
  ].filter(Boolean).join(" ");

  return (
    <li>
      {item.disabled ? (
        <span aria-disabled="true" className={classes}>
          <Icon aria-hidden="true" className="size-[18px]" />
          {t(menuEntryLabelKey(item))}
        </span>
      ) : (
        <a
          aria-current={item.active ? "page" : undefined}
          className={classes}
          data-astro-prefetch="hover"
          href={item.url}
          onClick={onNavigate}
        >
          <Icon aria-hidden="true" className="size-[18px]" />
          {t(menuEntryLabelKey(item))}
        </a>
      )}
    </li>
  );
}
