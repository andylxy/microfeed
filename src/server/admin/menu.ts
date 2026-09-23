/**
 * Admin menu loading — the menu is data (`ext_menu`, migration 0041), so the
 * dashboard asks "which rows may this account see?" instead of rendering a
 * hard-coded array.
 *
 * The pipeline mirrors the BasicApp reference this was modelled on:
 *   visible rows -> per-row permission test -> sort -> tree -> prune -> fallback
 *
 * Two rules are load-bearing:
 *
 * 1. A row with no `permission_code` is a **public** menu (the dashboard home)
 *    and is visible to anyone signed in. Everything else needs its code.
 * 2. The permission test is {@link rbacAllows} — the same source the request
 *    guards use. A menu that disagreed with its page would show a link that
 *    403s, or hide a page the account may open.
 *
 * See `ADR-002-admin-menu-as-data.md`.
 */

import {rbacAllows, type RbacLocals} from "@/server/rbac/guard";
import {adminUrl} from "@/shared/AdminPath";
import type {AdminMenuItem} from "@/shared/AdminNavigation";
import {ADMIN_MENU_CODES} from "@/shared/Constants";

interface MenuRow {
  code: string;
  i18n_key: string;
  icon: string | null;
  parent_code: string | null;
  path: string;
  permission_code: string | null;
  sort: number;
}

const VISIBLE_ROWS = "SELECT code, parent_code, path, i18n_key, icon, " +
  "permission_code, sort FROM ext_menu WHERE is_visible = 1 ORDER BY sort, code";

interface MenuNode extends AdminMenuItem {
  children: MenuNode[];
}

/**
 * Drop parent nodes whose children were all filtered out — a heading that opens
 * nothing is worse than no heading. Bottom-up, so a parent emptied by pruning
 * its own child is removed too.
 */
function pruneEmptyParents(nodes: MenuNode[], parentCodes: Set<string>): MenuNode[] {
  const kept: MenuNode[] = [];
  for (const node of nodes) {
    node.children = pruneEmptyParents(node.children, parentCodes);
    const isParent = parentCodes.has(node.id);
    if (isParent && node.children.length === 0) continue;
    kept.push(node);
  }
  return kept;
}

/**
 * Build the menu for one request.
 *
 * @param locals Carries the resolved permission set and the account, so the
 *   wildcard and legacy-admin cases behave exactly as they do in the guards.
 * @param activeCode The menu code of the page being rendered, or `null`.
 * @param onboardingOk When the site is not set up yet, everything but the
 *   dashboard home is shown but disabled — the pre-existing behaviour.
 */
export async function readAdminMenu(
  db: D1Database,
  locals: RbacLocals,
  adminPath: string,
  activeCode: string | null,
  onboardingOk: boolean,
): Promise<AdminMenuItem[]> {
  const result = await db.prepare(VISIBLE_ROWS).all<MenuRow>();
  const rows = result.results ?? [];

  const allowed = rows.filter((row) => rbacAllows(locals, row.permission_code));
  if (allowed.length === 0) {
    return [homeEntry(adminPath, activeCode)];
  }

  const nodes = new Map<string, MenuNode>();
  for (const row of allowed) {
    nodes.set(row.code, {
      active: row.code === activeCode,
      children: [],
      disabled: row.code !== ADMIN_MENU_CODES.ADMIN_HOME && !onboardingOk,
      icon: row.icon,
      id: row.code,
      url: adminUrl(row.path, adminPath),
    });
  }

  // A group's code counts as a parent as long as *any* row points at it —
  // including a row this account may not see. Deriving this from `allowed`
  // instead would miss a group whose children were all filtered out, leaving an
  // empty heading behind.
  const parentCodes = new Set(
    rows
      .map((row) => row.parent_code)
      .filter((code): code is string => typeof code === "string" && code.length > 0),
  );

  const roots: MenuNode[] = [];
  for (const row of allowed) {
    const node = nodes.get(row.code);
    if (!node) continue;
    const parent = row.parent_code ? nodes.get(row.parent_code) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const tree = pruneEmptyParents(roots, parentCodes);
  if (tree.length === 0) {
    return [homeEntry(adminPath, activeCode)];
  }

  // A group has no landing page of its own: it links to its first visible
  // child. The main sidebar then renders it like any other entry, and the
  // group sub-sidebar lists the children.
  const linkGroups = (nodes: MenuNode[]): void => {
    for (const node of nodes) {
      const first = node.children[0];
      if (!first) continue;
      node.url = first.url;
      linkGroups(node.children);
    }
  };
  linkGroups(tree);

  return tree;
}

function homeEntry(adminPath: string, activeCode: string | null): AdminMenuItem {
  return {
    active: activeCode === ADMIN_MENU_CODES.ADMIN_HOME,
    disabled: false,
    icon: "home",
    id: ADMIN_MENU_CODES.ADMIN_HOME,
    url: adminUrl("", adminPath),
  };
}
