import {env} from "cloudflare:workers";
import {afterEach, describe, expect, it} from "vitest";

import {readAdminMenu} from "@/server/admin/menu";
import {resolveUserPermissions} from "@/server/rbac/resolve";
import type {AdminMenuItem} from "@/shared/AdminNavigation";
import {buildSidebarItems, roleSeesEntry} from "@/shared/AdminSidebarItems";
import {ADMIN_MENU_CODES} from "@/shared/Constants";
import {translate} from "@/shared/i18n";
import {
  PERMISSION_NODE_COLUMNS,
  toPermissionNodeRow,
  type PermissionNodeTableRow,
} from "@/shared/PermissionTreeOps";

const ADMIN_PATH = "admin";
const EDITORS = "u_menu_editor";
const SUPERS = "u_menu_super";
const LEGACY = "u_menu_legacy";
const READONLY = "u_menu_readonly";

async function seedAccount(id: string, roleId: string, role: string) {
  await env.FEED_DB.prepare(
    'INSERT OR REPLACE INTO "auth_user" ' +
      '(id, name, email, emailVerified, createdAt, updatedAt, role, banned) ' +
      "VALUES (?, ?, ?, 1, '2024-01-01', '2024-01-01', ?, 0)",
  ).bind(id, id, `${id}@example.com`, role).run();
  await env.FEED_DB.prepare(
    "INSERT OR REPLACE INTO ext_user_roles (user_id, role_id) VALUES (?, ?)",
  ).bind(id, roleId).run();
  return resolveUserPermissions(env.FEED_DB, id);
}

function locals(id: string, role: string, permissions: Set<string>) {
  return {authUser: {id, role}, rbacPermissions: permissions};
}

/** Depth-first ids, so a grouped menu reads like the flat list it replaced. */
function menuIds(items: AdminMenuItem[]): string[] {
  return items.flatMap((item) => [
    item.id,
    ...(item.children ? menuIds(item.children) : []),
  ]);
}

function findItem(items: AdminMenuItem[], id: string): AdminMenuItem | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    const hit = item.children ? findItem(item.children, id) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

/** The group rows a page hangs off, read from the tree that now drives the sidebar. */
async function groupCodes(): Promise<Set<string>> {
  const rows = await env.FEED_DB.prepare(
    "SELECT DISTINCT parent_code AS code FROM ext_permission_nodes " +
      "WHERE audience = 'desktop' AND kind = 'page' AND parent_code IS NOT NULL",
  ).all<{code: string}>();
  return new Set((rows.results ?? []).map((row) => row.code));
}

afterEach(async () => {
  await env.FEED_DB.batch([
    env.FEED_DB.prepare("DELETE FROM ext_user_roles"),
    env.FEED_DB.prepare('DELETE FROM "auth_user"'),
  ]);
});

/**
 * The sidebar has read `ext_permission_nodes` since 2026-10-21 (ADR-0042 D6); the
 * `ext_menu` seeds it used to be built from are gone as of migration 0168
 * (ADR-0057). These cases hold the node table to the invariants the old menu rows
 * carried — one row per nav entry, group headings without a code, every page
 * entry bound to a real permission — so the sidebar keeps a single, tested source.
 */
describe("admin menu seed", () => {
  it("has a page node for every menu code, plus one group node per parent", async () => {
    const rows = await env.FEED_DB.prepare(
      "SELECT code, kind FROM ext_permission_nodes WHERE audience = 'desktop'",
    ).all<{code: string; kind: string}>();
    const seeded = rows.results ?? [];
    const nodeCodes = new Set(seeded.map((row) => row.code));
    const menuCodes = new Set<string>(Object.values(ADMIN_MENU_CODES));
    const groups = await groupCodes();

    for (const code of menuCodes) {
      if (code === ADMIN_MENU_CODES.ADMIN_HOME) continue;
      expect(nodeCodes.has(`page_${code}`), `no page node for ${code}`).toBe(true);
    }
    // Every group heading the pages hang off must itself be a group node.
    for (const code of groups) {
      const node = seeded.find((row) => row.code === code);
      expect(node, `group ${code} has no node`).toBeDefined();
      expect(node?.kind, `${code} is a parent but not a group node`).toBe("group");
    }
  });

  it("binds every page entry but home to a real permission code", async () => {
    const rows = await env.FEED_DB.prepare(
      "SELECT code, entry_code FROM ext_permission_nodes " +
        "WHERE audience = 'desktop' AND kind = 'page'",
    ).all<{code: string; entry_code: string | null}>();
    const seeded = rows.results ?? [];

    // The home entry has no node: `buildSidebarItems` synthesises it. What the
    // seed must guarantee is the opposite — nothing pretends to be home.
    expect(
      seeded.some((row) => row.code === `page_${ADMIN_MENU_CODES.ADMIN_HOME}`),
    ).toBe(false);
    // `page_media` is the deliberate exception: `media` only carries codes and
    // is not in the sidebar, so it binds no code either.
    const unbindable = new Set(["page_media"]);

    const permissions = await env.FEED_DB.prepare(
      "SELECT code FROM ext_permissions",
    ).all<{code: string}>();
    const known = new Set((permissions.results ?? []).map((row) => row.code));

    for (const row of seeded) {
      if (unbindable.has(row.code)) {
        expect(row.entry_code, `${row.code} must not bind a code`).toBeNull();
        continue;
      }
      expect(row.entry_code, `node ${row.code} has no entry code`).toBeTruthy();
      expect(
        known.has(row.entry_code ?? ""),
        `node ${row.code} binds an unknown code`,
      ).toBe(true);
    }
  });

  it("gives every entry a path fragment and an i18n key", async () => {
    const rows = await env.FEED_DB.prepare(
      "SELECT code, path FROM ext_permission_nodes " +
        "WHERE audience = 'desktop' AND kind = 'page' AND is_visible = 1",
    ).all<{code: string; path: string | null}>();
    const seeded = rows.results ?? [];
    expect(seeded.length).toBeGreaterThan(0);
    for (const row of seeded) {
      // Every visible desktop page node needs a path, or its sidebar link
      // points at the root. Home has no node (it is synthesised), and
      // `page_media` is the one visible page that is not in the sidebar — it
      // sits outside the guard compared by `admin-page-guards.test.ts`.
      if (row.code === "page_media") {
        expect(row.path, "page_media is not in the sidebar").toBeNull();
        continue;
      }
      expect(row.path, `node ${row.code} has no path`).toBeTruthy();
    }
  });
});

describe("readAdminMenu", () => {
  it("shows an editor the content menus and nothing else", async () => {
    const permissions = await seedAccount(EDITORS, "r_editor", "user");
    const menu = await readAdminMenu(
      env.FEED_DB,
      locals(EDITORS, "user", permissions),
      ADMIN_PATH,
      null,
      true,
    );
    const codes = menuIds(menu);

    expect(codes).toContain(ADMIN_MENU_CODES.ADMIN_HOME);
    expect(codes).toContain(ADMIN_MENU_CODES.ALL_ITEMS);
    expect(codes).toContain(ADMIN_MENU_CODES.PAGES);
    expect(codes).toContain(ADMIN_MENU_CODES.SITE_FILES);
    expect(codes).not.toContain(ADMIN_MENU_CODES.USERS);
    expect(codes).not.toContain(ADMIN_MENU_CODES.RBAC);
    expect(codes).not.toContain(ADMIN_MENU_CODES.SETTINGS);
    expect(codes).not.toContain(ADMIN_MENU_CODES.REVIEW);
    expect(codes).not.toContain(ADMIN_MENU_CODES.AUDIT);
    expect(codes).not.toContain(ADMIN_MENU_CODES.API);
  });

  it("shows a readonly account the same menus as editor (readonly == editor)", async () => {
    const permissions = await seedAccount(READONLY, "r_readonly", "user");
    const menu = await readAdminMenu(
      env.FEED_DB,
      locals(READONLY, "user", permissions),
      ADMIN_PATH,
      null,
      true,
    );
    const codes = menuIds(menu);

    // 2026-10-16 起 readonly 与 editor 相同（用户要求同步）：content + pages + site-files。
    expect(codes).toContain(ADMIN_MENU_CODES.ADMIN_HOME);
    expect(codes).toContain(ADMIN_MENU_CODES.ALL_ITEMS);
    expect(codes).toContain(ADMIN_MENU_CODES.BOOKS);
    expect(codes).toContain(ADMIN_MENU_CODES.CATEGORIES);
    expect(codes).toContain(ADMIN_MENU_CODES.VOLUMES);
    expect(codes).toContain(ADMIN_MENU_CODES.PAGES);
    expect(codes).toContain(ADMIN_MENU_CODES.SITE_FILES);
    // Admin-only menus stay hidden (no system:*/content:review/audit/settings/api codes).
    expect(codes).not.toContain(ADMIN_MENU_CODES.REVIEW);
    expect(codes).not.toContain(ADMIN_MENU_CODES.AUDIT);
    expect(codes).not.toContain(ADMIN_MENU_CODES.USERS);
    expect(codes).not.toContain(ADMIN_MENU_CODES.RBAC);
    expect(codes).not.toContain(ADMIN_MENU_CODES.SETTINGS);
    expect(codes).not.toContain(ADMIN_MENU_CODES.API);
  });

  it("shows a wildcard holder everything, and a legacy admin only its grants", async () => {
    const pageCount = Object.values(ADMIN_MENU_CODES).length;
    const groupCount = (await groupCodes()).size;

    const superPermissions = await seedAccount(SUPERS, "r_super_admin", "user");
    const superMenu = await readAdminMenu(
      env.FEED_DB,
      locals(SUPERS, "user", superPermissions),
      ADMIN_PATH,
      null,
      true,
    );
    expect(menuIds(superMenu)).toHaveLength(pageCount + groupCount);

    // `auth_user.role = 'admin'` no longer authorises anything by itself: the
    // guard's legacy bypass is gone, and migration 0053 hands every
    // administrator the super_admin role instead. Without grants, home only.
    const legacyMenu = await readAdminMenu(
      env.FEED_DB,
      locals(LEGACY, "admin", new Set<string>()),
      ADMIN_PATH,
      null,
      true,
    );
    expect(menuIds(legacyMenu)).toEqual([ADMIN_MENU_CODES.ADMIN_HOME]);

    // Once adopted (the backfill's state) it sees everything, as before.
    const adopted = await seedAccount(LEGACY, "r_super_admin", "admin");
    const adoptedMenu = await readAdminMenu(
      env.FEED_DB,
      locals(LEGACY, "admin", adopted),
      ADMIN_PATH,
      null,
      true,
    );
    expect(menuIds(adoptedMenu)).toHaveLength(pageCount + groupCount);
  });

  it("falls back to the home entry when nothing is granted", async () => {
    const menu = await readAdminMenu(
      env.FEED_DB,
      locals("u_menu_none", "user", new Set<string>()),
      ADMIN_PATH,
      null,
      true,
    );
    expect(menu).toHaveLength(1);
    expect(menu[0]?.id).toBe(ADMIN_MENU_CODES.ADMIN_HOME);
  });

  it("disables every entry but home until setup is complete", async () => {
    const permissions = await seedAccount(EDITORS, "r_editor", "user");
    const menu = await readAdminMenu(
      env.FEED_DB,
      locals(EDITORS, "user", permissions),
      ADMIN_PATH,
      ADMIN_MENU_CODES.BOOKS,
      false,
    );
    const home = findItem(menu, ADMIN_MENU_CODES.ADMIN_HOME);
    const books = findItem(menu, ADMIN_MENU_CODES.BOOKS);
    expect(home?.disabled).toBe(false);
    expect(books?.disabled).toBe(true);
    expect(books?.active).toBe(true);
  });

  it("groups the seeded order and marks the current entry", async () => {
    const permissions = await seedAccount(SUPERS, "r_super_admin", "user");
    const menu = await readAdminMenu(
      env.FEED_DB,
      locals(SUPERS, "user", permissions),
      ADMIN_PATH,
      ADMIN_MENU_CODES.WEBHOOKS,
      true,
    );

    // Order lives in the table (`sort`), not in code, so this is the guard that
    // used to sit on the hard-coded array. Depth-first: each heading is
    // followed by its children.
    expect(menuIds(menu)).toEqual([
      ADMIN_MENU_CODES.ADMIN_HOME,
      "group_content",
      ADMIN_MENU_CODES.BOOKS,
      // 0142: the book status dictionary sits right after the books board.
      ADMIN_MENU_CODES.BOOK_STATUSES,
      ADMIN_MENU_CODES.VOLUMES,
      ADMIN_MENU_CODES.CATEGORIES,
      ADMIN_MENU_CODES.ALL_ITEMS,
      ADMIN_MENU_CODES.ANNOTATION_MARKERS,
      ADMIN_MENU_CODES.FANGS,
      ADMIN_MENU_CODES.ALIASES,
      ADMIN_MENU_CODES.YAO,
      ADMIN_MENU_CODES.TERM,
      "group_review",
      ADMIN_MENU_CODES.REVIEW,
      ADMIN_MENU_CODES.AUDIT,
      "group_site",
      ADMIN_MENU_CODES.EDIT_CHANNEL,
      ADMIN_MENU_CODES.PAGES,
      ADMIN_MENU_CODES.SITE_FILES,
      ADMIN_MENU_CODES.SETTINGS,
      "group_integration",
      ADMIN_MENU_CODES.API,
      ADMIN_MENU_CODES.WEBHOOKS,
      "group_account",
      ADMIN_MENU_CODES.RBAC,
      // 0131 起单页口径：rbac_app 菜单行随双控制台一起退役。
      ADMIN_MENU_CODES.USERS,
      ADMIN_MENU_CODES.RBAC_AUDIT,
      "group_operations",
      ADMIN_MENU_CODES.DEVICES,
      ADMIN_MENU_CODES.APP_VERSIONS,
      ADMIN_MENU_CODES.LOGIN_LOGS,
      ADMIN_MENU_CODES.ANNOUNCEMENTS,
      // 0123 seeded the cloud-usage page as the group's last entry.
      ADMIN_MENU_CODES.CLOUD_USAGE,
      // 0145 seeded the app about-page content board after cloud usage.
      ADMIN_MENU_CODES.APP_ABOUT,
      // 0150 seeded the login-methods board after the about page.
      ADMIN_MENU_CODES.APP_LOGIN_METHODS,
      // 0152 seeded the cache control board last.
      ADMIN_MENU_CODES.APP_CACHE,
    ]);
    expect(findItem(menu, ADMIN_MENU_CODES.WEBHOOKS))
      .toMatchObject({active: true, url: "/admin/webhooks/"});
    // A group has no landing page: it links to its first visible child.
    expect(findItem(menu, "group_content")?.url).toBe("/admin/books/");
    expect(findItem(menu, "group_account")?.url).toBe("/admin/rbac/");
    expect(findItem(menu, "group_operations")?.url).toBe("/admin/devices/");
  });
});

/**
 * 侧栏自 2026-10-21 起读 `ext_permission_nodes`（ADR-0042 D6），`ext_menu` 已随迁移
 * 0168 删除（ADR-0057）。原先整组「permission-tree sidebar source」比对的是「菜单行
 * 与节点行是否一致」——基准表没了，这组断言的对象随之消失。0133 把菜单行整批复制进
 * 节点表这件事由 `tests/unit/permission-node-entry-migration.test.ts` 在迁移层面守住
 * （它自建一张最小 `ext_menu` 再跑 0133），所以这里不再保留同一口径的运行时副本。
 *
 * 仍然留下的是两条不依赖旧表、且只有这里能查的约束：只挂码不进侧栏的页面两列为空、
 * 名称列与 i18n 文案不漂移。
 */
describe("permission-tree sidebar source", () => {
  it("gives every group heading a visible desktop group node", async () => {
    const groups = await groupCodes();
    const nodeRows = await env.FEED_DB.prepare(
      "SELECT code FROM ext_permission_nodes " +
        "WHERE audience = 'desktop' AND kind = 'group' AND is_visible = 1",
    ).all<{code: string}>();
    const codes = new Set((nodeRows.results ?? []).map((row) => row.code));

    expect(groups.size).toBeGreaterThan(0);
    for (const code of groups) {
      expect(codes.has(code), `group ${code} has no node`).toBe(true);
    }
  });

  it("leaves path and entry code empty on pages that are not in the sidebar", async () => {
    // ADR-0042 验证口径 阶段1：`media` 这类只挂码、不进侧栏的页面两列都为空。
    const media = await env.FEED_DB.prepare(
      "SELECT path, entry_code FROM ext_permission_nodes WHERE code = 'page_media'",
    ).first<{entry_code: string | null; path: string | null}>();
    expect(media).toEqual({path: null, entry_code: null});
  });

  it("keeps the seeded display names equal to the nav text they replace", async () => {
    // 0127 决策 6：页面节点的名称列是 i18n 文案的冗余副本；侧栏改读节点后这一列
    // 就是导航上的字，两侧一漂移，切换就等于悄悄改了入口名称（ADR-0042 D6）。
    const nodeRows = await env.FEED_DB.prepare(
      "SELECT code, name_zh, name_en FROM ext_permission_nodes " +
        "WHERE audience = 'desktop' AND kind = 'page' AND entry_code IS NOT NULL",
    ).all<{code: string; name_en: string | null; name_zh: string | null}>();

    const rows = nodeRows.results ?? [];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const navCode = row.code.replace(/^page_/u, "");
      expect(row.name_zh, `zh label drift for ${navCode}`)
        .toBe(translate(`menu.item.${navCode}`, "zh-CN"));
      expect(row.name_en, `en label drift for ${navCode}`)
        .toBe(translate(`menu.item.${navCode}`, "en"));
    }
  });

  it("gives the preview and the real sidebar the same rows for the same account", async () => {
    // 预览用 `roleSeesEntry`（没有 locals），真实侧栏用 `rbacAllows`；两侧对非空
    // 门码的结论必须相同，否则预览会对着一个不存在的侧栏给运营调门码。
    const permissions = await seedAccount(EDITORS, "r_editor", "user");
    const real = await readAdminMenu(
      env.FEED_DB,
      locals(EDITORS, "user", permissions),
      ADMIN_PATH,
      null,
      true,
    );

    const nodeRows = await env.FEED_DB.prepare(
      `SELECT ${PERMISSION_NODE_COLUMNS} FROM ext_permission_nodes
        WHERE audience = 'desktop' AND is_visible = 1 AND kind IN ('group', 'page')
        ORDER BY sort, code`,
    ).all<PermissionNodeTableRow>();
    const preview = buildSidebarItems(
      (nodeRows.results ?? []).map(toPermissionNodeRow),
      (entryCode) => roleSeesEntry([...permissions], entryCode),
      ADMIN_PATH,
    ).items;

    expect(preview).toEqual(real);
  });
});
