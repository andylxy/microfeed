/**
 * 侧栏预览（ADR-0042 D5）。
 *
 * 只读复刻真实侧栏：行集按权限节点拼出来（`buildSidebarItems`，入口门码门控），
 * 第三级子项注入走与真实侧栏同一份 `SUB_SECTION_BUILDERS`，视觉沿用侧栏的行样式。
 * 与真实侧栏不同之处只有三处：
 *  - 不跳转——行渲染成 `span`，不带链接；
 *  - 不写共享展开态（`menu-open-state`），预览的折叠不影响真实侧栏；
 *  - 分组默认全部展开，整棵行集一眼看完；点分组行只收自己的子项。
 */
import {useMemo, useState, type CSSProperties} from "react";
import {ChevronDownIcon, Minimize2Icon, Maximize2Icon} from "lucide-react";

import {Button} from "@/components/ui/button";
import {useTranslation} from "@/client/i18n";
import {parseAdminLanguage} from "@/shared/AdminLanguage";
import {
  adminMenuItemText,
  type AdminMenuItem,
} from "@/shared/AdminNavigation";
import {buildSidebarItems, roleSeesEntry} from "@/shared/AdminSidebarItems";
import {type PermissionNodeRow} from "@/shared/PermissionTreeOps";
import {cn} from "@/lib/utils";
import {withPageSections} from "@/components/admin/AdminSidebar";
import {
  FALLBACK_MENU_ICON,
  MENU_ICONS,
} from "@/components/admin/AdminMenuItemLink";

/** 预览行的样式与真实侧栏一致，但读作静态展示（不跳转、不高亮）。 */
const PREVIEW_ROW_CLASSES =
  "relative flex min-h-9 w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left text-sm font-medium text-sidebar-foreground";

/** 层级缩进随深度走：每层 0.75rem，与真实侧栏的 `pl-4` 一档对齐。 */
function rowIndent(depth: number): CSSProperties | undefined {
  return depth > 0 ? {paddingLeft: `${0.75 + depth * 0.75}rem`} : undefined;
}

function PreviewRow({depth, item}: {depth: number; item: AdminMenuItem}) {
  const {t, i18n} = useTranslation();
  const Icon = (item.icon && MENU_ICONS[item.icon]) || FALLBACK_MENU_ICON;
  const label = adminMenuItemText(item, parseAdminLanguage(i18n.language), t);
  return (
    <li>
      <span className={PREVIEW_ROW_CLASSES} style={rowIndent(depth)}>
        <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </span>
    </li>
  );
}

function PreviewTree({items}: {items: AdminMenuItem[]}) {
  const {t, i18n} = useTranslation();
  const language = parseAdminLanguage(i18n.language);
  // 折叠的是分组行本身；空集合 = 全部展开。
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const toggleGroup = (id: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const rowLabel = (item: AdminMenuItem) => adminMenuItemText(item, language, t);

  const render = (list: AdminMenuItem[], depth: number) =>
    list.map((item) => {
      const children = item.children ?? [];
      const key = item.id;
      if (children.length === 0) {
        return <PreviewRow depth={depth} item={item} key={key} />;
      }
      const open = !collapsed.has(key);
      return (
        <li key={key}>
          <button
            aria-expanded={open}
            aria-label={t("rbac.sidebarPreview.toggleGroup", {name: rowLabel(item)})}
            className={PREVIEW_ROW_CLASSES}
            style={rowIndent(depth)}
            onClick={() => toggleGroup(key)}
            type="button"
          >
            <ChevronDownIcon
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                !open && "-rotate-90",
              )}
            />
            <span className="min-w-0 flex-1 truncate">{rowLabel(item)}</span>
          </button>
          {open && (
            <ul
              className="mt-0.5 grid gap-0.5 border-l border-sidebar-border pl-2.5"
              style={{marginLeft: `${0.75 + depth * 0.75}rem`}}
            >
              {render(children, depth + 1)}
            </ul>
          )}
        </li>
      );
    });

  return <ul className="grid gap-0.5">{render(items, 0)}</ul>;
}

interface SidebarPreviewProps {
  /** 桌面端权限节点行（权限树接口的 `desktop` 端行集）。 */
  nodes: readonly PermissionNodeRow[];
  /** 当前选中角色的权限码集合；含 `*` 时全见。 */
  permissions: readonly string[];
  /** 是否收起面板（开关状态由调用方持有）。 */
  collapsed: boolean;
  onToggle: () => void;
}

export default function SidebarPreview({
  collapsed,
  nodes,
  onToggle,
  permissions,
}: SidebarPreviewProps) {
  const {t} = useTranslation();
  // 行集 + 计数由节点与所选角色的权限集合决定，切换角色即刻重算。
  const {items: baseItems, pageCount} = useMemo(
    () => buildSidebarItems(nodes, (entryCode) => roleSeesEntry(permissions, entryCode)),
    [nodes, permissions],
  );
  // 第三级子项与真实侧栏同一份 builder 注入；预览不做活动态判定，传空值。
  const items = useMemo(() => withPageSections(baseItems, "", "", undefined), [baseItems]);

  return (
    <section className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-sidebar-border px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-sidebar-foreground">
            {t("rbac.sidebarPreview.title")}
          </h3>
          <p className="mt-0.5 truncate text-xs text-sidebar-foreground/70">
            {t("rbac.sidebarPreview.hint")}
          </p>
        </div>
        <Button
          aria-label={
            collapsed ? t("rbac.sidebarPreview.expand") : t("rbac.sidebarPreview.collapse")
          }
          className="size-8 shrink-0"
          size="icon"
          type="button"
          variant="ghost"
          onClick={onToggle}
        >
          {collapsed ? (
            <Maximize2Icon aria-hidden="true" />
          ) : (
            <Minimize2Icon aria-hidden="true" />
          )}
        </Button>
      </header>
      {!collapsed && (
        <div className="flex-1 overflow-y-auto p-2">
          <PreviewTree items={items} />
          {pageCount === 0 && (
            <p className="mt-3 rounded-xl border border-sidebar-border bg-sidebar-accent px-3 py-2 text-xs leading-5 text-sidebar-foreground/70">
              {t("rbac.sidebarPreview.empty")}
            </p>
          )}
        </div>
      )}
      {!collapsed && (
        <footer className="border-t border-sidebar-border px-3 py-2 text-xs text-sidebar-foreground/70">
          {pageCount === 1
            ? t("rbac.sidebarPreview.entriesOne", {count: pageCount})
            : t("rbac.sidebarPreview.entriesOther", {count: pageCount})}
        </footer>
      )}
    </section>
  );
}
