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
  disabled: boolean;
  icon: string | null;
  id: string;
  url: string;
}
