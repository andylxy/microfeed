import type {AdminLanguage} from "./AdminLanguage";
import {ADMIN_MENU_CODES} from "./Constants";

/** A stable menu code, e.g. `all_items`. */
export type AdminMenuCode = typeof ADMIN_MENU_CODES[keyof typeof ADMIN_MENU_CODES];

/**
 * One rendered menu entry, as built from `ext_permission_nodes` (see
 * `src/server/admin/menu.ts` and `src/shared/AdminSidebarItems.ts`).
 *
 * There is deliberately no list of menu items here. The navigation is data — its
 * path, icon, entry code and order all live in the permission tree — so this
 * module holds only the shape the renderer consumes, plus the codes pages use to
 * mark the current item.
 *
 * The renderer only ever receives what the account may see; it never sees the
 * permission set itself. `icon` is a name (e.g. `book`), not a component.
 */
export interface AdminMenuItem {
  active: boolean;
  /**
   * Present on a *group* row (a heading, not a link): its children, already
   * filtered to what the account may see. A group whose children were all
   * filtered out is pruned before it reaches the renderer, so this is either
   * absent (a leaf) or non-empty.
   */
  children?: AdminMenuItem[];
  disabled: boolean;
  icon: string | null;
  id: string;
  /**
   * Database display names (`ext_permission_nodes.name_zh` / `name_en`),
   * present only when at least one column holds a non-blank value (plan
   * §2.3.1). Either part may be an empty string. When the column for the
   * current language is blank the other column's value is used; the renderer
   * falls back to the `i18n_key` text only when *both* are empty (see
   * `adminMenuItemLabel`).
   */
  label?: {en: string; zh: string};
  /**
   * Direct i18n key override for rows that are not navigation nodes — the
   * settings sections injected by `AdminSidebar`. Checked only after `label`;
   * when both are absent the label resolves through `menuEntryLabelKey`.
   */
  labelKey?: string;
  /**
   * The permission-tree node this row came from (`ext_permission_nodes.code`,
   * e.g. `page_settings`), present once the sidebar reads nodes (ADR-0042 D6).
   *
   * `id` stays the menu code so the `menu.item.*` / `menu.group.*` fallback and
   * the remembered expand state keep working; the node code is the identity
   * that survives the retirement of `ext_menu`, and it is what the third-level
   * injection registry (`SUB_SECTION_BUILDERS`) keys on.
   */
  nodeCode?: string;
  url: string;
}

/** A group row's heading key: `group_content` -> `menu.group.content`. */
export function menuGroupLabelKey(code: string): string {
  return `menu.group.${code.replace(/^group_/u, "")}`;
}

/** A page row's heading key: `books` -> `menu.item.books`. */
export function menuItemLabelKey(code: string): string {
  return `menu.item.${code}`;
}

/** 行 code → 标签键：分组用 `menu.group.*`，页面用 `menu.item.*`。 */
export function menuRowLabelKey(code: string): string {
  return code.startsWith("group_") ? menuGroupLabelKey(code) : menuItemLabelKey(code);
}

/**
 * The heading key for one rendered entry: a group reads `menu.group.*`, a page
 * reads `menu.item.*`. Keyed off the `group_` code prefix rather than
 * `children.length`, because a page node may carry injected children (the
 * settings sections, see `AdminSidebar`) and must still keep its own
 * `menu.item.*` label. Shared so the sidebar, the group sub-sidebar and the
 * role editor's permission tree cannot drift apart.
 */
export function menuEntryLabelKey(item: AdminMenuItem): string {
  return menuRowLabelKey(item.id);
}

/**
 * Display name for one menu entry (plan §2.3.1): the database value wins, the
 * current language's column first, the other column when it is blank. Takes the
 * label pair itself rather than the whole entry, so the menu management table
 * can hand it the `name_zh` / `name_en` columns it already holds; returns `null`
 * only when both columns are empty — the caller then falls back to the
 * `menu.item.*` / `menu.group.*` text. Keeping the precedence in one shared
 * function is what stops the sidebar and every other renderer from drifting
 * apart.
 */
export function adminMenuItemLabel(
  label: AdminMenuItem["label"],
  language: AdminLanguage,
): string | null {
  if (!label) return null;
  const preferred = language === "zh-CN" ? label.zh : label.en;
  const other = language === "zh-CN" ? label.en : label.zh;
  return preferred.trim() || other.trim() || null;
}

/**
 * 一行在侧栏里显示的文字：数据库名称优先，两列都空时回退到 `labelKey` /
 * `menu.item.*` 的 i18n 文案。真实侧栏与侧栏预览共用这一份——两处各写一遍，
 * 预览就会在某个回退分支上说出与真实侧栏不同的字（ADR-0042 D5 要求逐项一致）。
 */
export function adminMenuItemText(
  item: AdminMenuItem,
  language: AdminLanguage,
  t: (key: string) => string,
): string {
  return adminMenuItemLabel(item.label, language) ??
    t(item.labelKey ?? menuEntryLabelKey(item));
}
