import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";

import {readRbacBoard} from "@/server/admin/rbac-handlers";
import {
  buildGrantGroupsFromNodes,
  PERMISSION_NODE_COLUMNS,
  toPermissionNodeRow,
  type PermissionNodeRow,
  type PermissionNodeTableRow,
} from "@/shared/PermissionTreeOps";

/**
 * Permission-tree self-hosted invariants (ADR-0038, ticket 06).
 *
 * The role editor's grant tree now comes entirely from `ext_permission_nodes`
 * (readRbacBoard -> buildGrantGroupsFromNodes). Migration 0127 froze the tree
 * that `ext_menu` + `ext_menu_permissions` used to derive through
 * `buildPermissionTree`, which has since been retired. These cases guard the
 * post-migration state directly against the node table — no legacy comparison
 * target remains.
 */

/** The new read path's assembly input, straight from the node table. */
async function readNodeRows(): Promise<PermissionNodeRow[]> {
  const rows = await env.FEED_DB.prepare(
    `SELECT ${PERMISSION_NODE_COLUMNS} FROM ext_permission_nodes ORDER BY sort, code`,
  ).all<PermissionNodeTableRow>();
  return (rows.results ?? []).map(toPermissionNodeRow);
}

describe("permission tree self-hosted invariants (ADR-0038)", () => {
  it("carries node names on groups and pages for the grant tree labels", async () => {
    // 组/页标签改走节点双名 → i18n 兜底键 → code（ADR-0038 D6）：固化行必须
    // 带着入库的双语名，否则角色 tab 的树只剩裸 code。
    const nodeRows = await readNodeRows();
    const catalog = await env.FEED_DB.prepare(
      "SELECT code, name FROM ext_permissions ORDER BY code",
    ).all<{code: string; name: string}>();
    const names = new Map((catalog.results ?? []).map((row) => [row.code, row.name]));

    const desktop = buildGrantGroupsFromNodes(nodeRows, names, "desktop");
    const content = desktop.find((group) => group.code === "group_content");
    expect(content?.nameZh).toBe("内容");
    expect(content?.nameEn).toBe("Content");
    const books = content?.pages.find((page) => page.code === "books");
    expect(books?.nameZh).toBe("书籍");

    // App 端的节点行在 0129 收拢到 `group_app` 下，名字同样入库；0131 并页后
    // 版本叶子挂在 app访问、名词叶子挂在 app搜索，独立页行随之退役。
    const app = buildGrantGroupsFromNodes(nodeRows, names, "app");
    expect(app.map((group) => group.code)).toEqual(["group_app"]);
    expect(app[0]?.nameZh).toBe("App 端");
    const accessPage = app[0]?.pages.find((page) => page.code === "app_access");
    expect(accessPage?.nameZh).toBe("app访问");
    expect(accessPage?.codes).toContain("app:version:read");
    const searchPage = app[0]?.pages.find((page) => page.code === "app_search");
    expect(searchPage?.codes).toContain("app:mingci:view");
    expect(app[0]?.pages.some((page) => page.code === "app_version_read")).toBe(false);
    expect(
      desktop
        .flatMap((group) => group.pages)
        .some((page) => page.code === "app_version_read"),
    ).toBe(false);
  });

  it("keeps every assignable code reachable in the new tree", async () => {
    // The catch-up guard for full retirement (ticket 06): a code that lost its
    // node row would silently become ungrantable.
    const board = await readRbacBoard(env.FEED_DB, "desktop");
    const treeCodes = board.groups
      .flatMap((group) => group.pages)
      .flatMap((page) => page.codes)
      .sort();
    const assignable = board.permissions
      .map((entry) => entry.code)
      .filter((code) => code !== "*")
      .sort();
    expect(treeCodes).toEqual(assignable);
  });
});
