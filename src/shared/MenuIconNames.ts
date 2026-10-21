/**
 * `ext_permission_nodes.icon` 允许出现的图标名清单：服务端保存校验与前端选择器共用
 * 同一份，与 `src/components/admin/AdminMenuItemLink.tsx` 的 MENU_ICONS 映射逐一对应，
 * 由 `tests/unit/menu-icon-registry.test.ts` 守住两边不漂移——未登记的图标名会静默
 * 回退 ListIcon，属于最难发现的一类缺陷。
 *
 * 放在 `src/shared/` 是因为服务端（保存校验）与浏览器（选择器渲染）都要读它，
 * 而 MENU_ICONS 本身是组件模块（导入 lucide-react），server 侧不能引。
 */
export const MENU_ICON_NAMES = [
  "activity",
  "blocks",
  "book",
  "cloud",
  "code",
  "code-2",
  "database",
  "download",
  "eye",
  "file-code-2",
  "file-text",
  "flask-conical",
  "globe",
  "history",
  "home",
  "image",
  "key-round",
  "layers",
  "leaf",
  "list",
  "list-checks",
  "pencil",
  "pill",
  "rss",
  "settings",
  "shield",
  "shield-check",
  "smartphone",
  "storage",
  "tags",
  "upload",
  "users",
  "webhook",
] as const;

export type MenuIconName = (typeof MENU_ICON_NAMES)[number];

export function isMenuIconName(value: string): value is MenuIconName {
  return (MENU_ICON_NAMES as readonly string[]).includes(value);
}

/** 图标下拉的选项清单（不带「无图标」入口）：按当前语言渲染 `menu.icon.<name>`。 */
export function menuIconOptions(
  t: (key: string) => string,
): {label: string; value: string}[] {
  return MENU_ICON_NAMES.map((name) => ({
    label: t(`menu.icon.${name}`),
    value: name,
  }));
}
