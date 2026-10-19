import {useEffect, useSyncExternalStore} from "react";

import {
  ActivityIcon,
  BlocksIcon,
  BookIcon,
  ChevronDownIcon,
  CloudIcon,
  Code2Icon,
  CodeIcon,
  DatabaseIcon,
  DownloadIcon,
  EyeIcon,
  FileCode2Icon,
  FileTextIcon,
  FlaskConicalIcon,
  GlobeIcon,
  HardDriveIcon,
  HistoryIcon,
  HomeIcon,
  ImageIcon,
  KeyRoundIcon,
  LayersIcon,
  LeafIcon,
  ListChecksIcon,
  ListIcon,
  PencilIcon,
  PillIcon,
  RssIcon,
  SettingsIcon,
  ShieldCheckIcon,
  ShieldIcon,
  SmartphoneIcon,
  TagsIcon,
  UploadIcon,
  UsersIcon,
  WebhookIcon,
} from "lucide-react";

import {useTranslation} from "@/client/i18n";
import {
  isMenuCodeOpen,
  openMenuCode,
  subscribeMenuState,
  toggleMenuCode,
} from "@/client/menu-open-state";
import {parseAdminLanguage} from "@/shared/AdminLanguage";
import {
  adminMenuItemLabel,
  menuEntryLabelKey,
  type AdminMenuItem,
} from "@/shared/AdminNavigation";

interface Props {
  /** 层级：0 = 顶层（分组）。只有顶层参与手风琴互斥。 */
  depth?: number;
  item: AdminMenuItem;
  onNavigate?: () => void;
  /** 顶层菜单码。展开某个顶层时用它收起其余顶层。 */
  topLevelCodes?: readonly string[];
}

/**
 * Menu icons are named in the data (`ext_menu.icon`, e.g. "book"), so this
 * resolves a name to a component instead of keying off a menu id. An unknown
 * name falls back rather than rendering an empty slot.
 *
 * 导出的键集合必须与 `src/shared/MenuIconNames.ts` 的 MENU_ICON_NAMES 一一对应
 * （`tests/unit/menu-admin-ops.test.ts` 守住）：服务端保存校验读共享清单，
 * 渲染读这张表，漂移会以「静默回退 ListIcon」的形态出现。
 */
export const MENU_ICONS: Record<string, typeof HomeIcon> = {
  activity: ActivityIcon,
  blocks: BlocksIcon,
  book: BookIcon,
  cloud: CloudIcon,
  code: CodeIcon,
  "code-2": Code2Icon,
  database: DatabaseIcon,
  download: DownloadIcon,
  eye: EyeIcon,
  "file-code-2": FileCode2Icon,
  "file-text": FileTextIcon,
  "flask-conical": FlaskConicalIcon,
  globe: GlobeIcon,
  history: HistoryIcon,
  home: HomeIcon,
  image: ImageIcon,
  "key-round": KeyRoundIcon,
  layers: LayersIcon,
  leaf: LeafIcon,
  list: ListIcon,
  "list-checks": ListChecksIcon,
  pencil: PencilIcon,
  pill: PillIcon,
  rss: RssIcon,
  settings: SettingsIcon,
  shield: ShieldIcon,
  "shield-check": ShieldCheckIcon,
  smartphone: SmartphoneIcon,
  storage: HardDriveIcon,
  tags: TagsIcon,
  upload: UploadIcon,
  users: UsersIcon,
  webhook: WebhookIcon,
};

const FALLBACK_MENU_ICON = ListIcon;

/** 当前页的祖先链必须可见，否则用户看不到自己站在哪里。 */
export function hasActiveDescendant(item: AdminMenuItem): boolean {
  return (item.children ?? []).some(
    (child) => child.active || hasActiveDescendant(child),
  );
}

function rowClasses(active: boolean, disabled: boolean): string {
  return [
    "relative flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-base font-medium outline-none transition-colors",
    active
      ? "bg-brand-light/12 text-brand-dark before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-brand-light dark:text-brand-light"
      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground",
    disabled ? "cursor-not-allowed opacity-45" : "",
  ].filter(Boolean).join(" ");
}

/**
 * One row in the admin menu tree.
 *
 * A row with children is a button that expands them in place — the menu is
 * data (`ext_menu.parent_code`), so depth comes from the table and this
 * component recurses to whatever depth the rows describe. A leaf row stays a
 * link. Expand state lives in `menu-open-state` (shared so sibling rows can
 * react to one another: only one top level stays open), is remembered per
 * account, and the chain leading to the current page is always open.
 */
export default function AdminMenuItemLink({
  depth = 0,
  item,
  onNavigate,
  topLevelCodes,
}: Props) {
  const {t, i18n} = useTranslation();
  const Icon = (item.icon && MENU_ICONS[item.icon]) || FALLBACK_MENU_ICON;
  const children = item.children ?? [];
  const hasChildren = children.length > 0;
  const containsActive = hasActiveDescendant(item);
  // 服务端快照同取 store：本组件只经 client:only 上岛，真服务端渲染走不到；
  // 服务端没有 window 时 store 恒为空集合，快照恒 false，与默认 false 等价。
  const open = useSyncExternalStore(
    subscribeMenuState,
    () => isMenuCodeOpen(item.id),
    () => isMenuCodeOpen(item.id),
  );
  // 当前页的祖先链必须可见：顶层由 AdminSidebar 的 syncMenuTopLevel 负责，
  // 这里补上更深的节点（如「集成 → API」的 API 行），否则停在深层子页时
  // 看不到自己站在哪。
  useEffect(() => {
    if (containsActive) openMenuCode(item.id);
  }, [containsActive, item.id]);
  // 数据库维护的展示名优先（0125 的 name_zh / name_en），两列都为空时回退到
  // i18n 文案。回退必须保留，否则改一个名称就得发一次版本。
  const label = adminMenuItemLabel(
    item.label,
    parseAdminLanguage(i18n.language),
  ) ?? t(item.labelKey ?? menuEntryLabelKey(item));

  const toggleOpen = () => {
    toggleMenuCode(item.id, depth, topLevelCodes ?? []);
  };

  if (!hasChildren) {
    return (
      <li>
        {item.disabled ? (
          <span aria-disabled="true" className={rowClasses(item.active, true)}>
            <Icon aria-hidden="true" className="size-[18px]" />
            {label}
          </span>
        ) : (
          <a
            aria-current={item.active ? "page" : undefined}
            className={rowClasses(item.active, false)}
            data-astro-prefetch="hover"
            href={item.url}
            onClick={onNavigate}
          >
            <Icon aria-hidden="true" className="size-[18px]" />
            {label}
          </a>
        )}
      </li>
    );
  }

  return (
    <li>
      <button
        aria-expanded={open}
        className={rowClasses(item.active || containsActive, item.disabled)}
        disabled={item.disabled}
        onClick={toggleOpen}
        type="button"
      >
        <ChevronDownIcon
          aria-hidden="true"
          className={`size-4 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}
        />
        <span className="min-w-0 flex-1">{label}</span>
      </button>
      {open && (
        <ul className="mt-1 grid gap-1 border-l border-sidebar-border pl-4">
          {children.map((child) => (
            <AdminMenuItemLink
              depth={depth + 1}
              item={child}
              key={child.id}
              onNavigate={onNavigate}
              topLevelCodes={topLevelCodes}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
