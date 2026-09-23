import {ADMIN_MENU_CODES} from "./Constants";

/** A stable menu code, e.g. `all_items`. */
export type AdminMenuCode = typeof ADMIN_MENU_CODES[keyof typeof ADMIN_MENU_CODES];

/**
 * One rendered menu entry, as loaded from `ext_menu` (see
 * `src/server/admin/menu.ts`).
 *
 * There is deliberately no list of menu items here. The menu is data — its
 * path, icon, permission code and order all live in the table — so this module
 * holds only the shape the renderer consumes, plus the codes pages use to mark
 * the current item. See `ADR-002-admin-menu-as-data.md`.
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

/**
 * The heading key for one rendered entry: a group reads `menu.group.*`, a page
 * reads `menu.item.*`. Shared so the sidebar, the group sub-sidebar and the
 * role editor's permission tree cannot drift apart.
 */
export function menuEntryLabelKey(item: AdminMenuItem): string {
  return item.children?.length
    ? menuGroupLabelKey(item.id)
    : menuItemLabelKey(item.id);
}
