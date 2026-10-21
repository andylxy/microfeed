/**
 * Admin menu loading — the sidebar is the permission tree
 * (`ext_permission_nodes`, ADR-0041 / ADR-0042 D6), so the dashboard asks
 * "which rows may this account see?" instead of rendering a hard-coded array.
 *
 * The tree assembly lives in `buildSidebarItems`, shared with the role editor's
 * sidebar preview, so the two cannot disagree about ordering, pruning, or how a
 * group links to its first child. What stays here is the server-only part: the
 * query and the gate.
 *
 * Two rules are load-bearing:
 *
 * 1. A group row carries no entry code and is a public heading.
 * 2. A page row needs a non-empty `entry_code`, tested with {@link rbacAllows} —
 *    the same decision the request guards make. A menu that disagreed with its
 *    page would show a link that 403s, or hide a page the account may open.
 *
 * 等价性证据（本地快照实测，0133 已应用）：按本查询拼出的行集 = 合成首页 +
 * 26 个过门控页面 + 6 分组，与读 `ext_menu` 的输出在顺序、路径、门码上逐项一致。
 * `admin_home` 没有节点行，仍由 `buildSidebarItems` 合成。
 */

import {rbacAllows, type RbacLocals} from "@/server/rbac/guard";
import {buildSidebarItems} from "@/shared/AdminSidebarItems";
import type {AdminMenuItem} from "@/shared/AdminNavigation";
import {ADMIN_MENU_CODES} from "@/shared/Constants";
import {
  PERMISSION_NODE_COLUMNS,
  toPermissionNodeRow,
  type PermissionNodeTableRow,
} from "@/shared/PermissionTreeOps";

/**
 * 侧栏只要分组行与页面行：码行是勾选项，不进侧栏；App 端没有侧栏。
 * 列清单取共享常量，免得与权限树接口的映射分家。
 *
 * 取数代价（本地快照实测，0133 已应用）：走复合索引
 * `ix_ext_permission_nodes_audience(audience, kind)`，不扫全表；匹配 34 行
 * （desktop 6 分组 + 28 页面，全表 95 行），读回 16 列约 4.3 KB（4288 字节），
 * 一次请求行读 34 行。`ORDER BY sort, code` 借临时 B 树排序，只排这 34 行。
 */
const NODE_ROWS = `SELECT ${PERMISSION_NODE_COLUMNS} FROM ext_permission_nodes
  WHERE audience = 'desktop' AND is_visible = 1 AND kind IN ('group', 'page')
  ORDER BY sort, code`;

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
  const result = await db.prepare(NODE_ROWS).all<PermissionNodeTableRow>();
  const nodes = (result.results ?? []).map(toPermissionNodeRow);
  const {items} = buildSidebarItems(
    nodes,
    (entryCode) => rbacAllows(locals, entryCode),
    adminPath,
    activeCode,
  );
  return onboardingOk ? items : disableUntilReady(items);
}

/** 站点未设置完时除首页外一律置灰：改造前就是这条行为，切换侧栏时不该顺手改掉。 */
function disableUntilReady(items: AdminMenuItem[]): AdminMenuItem[] {
  return items.map((item) => {
    const next: AdminMenuItem = {
      ...item,
      disabled: item.id !== ADMIN_MENU_CODES.ADMIN_HOME,
    };
    if (item.children) {
      next.children = disableUntilReady(item.children);
    }
    return next;
  });
}
