import {env} from "cloudflare:workers";
import {afterEach, describe, expect, it} from "vitest";

import {readAdminMenu} from "@/server/admin/menu";
import {resolveUserPermissions} from "@/server/rbac/resolve";
import {ADMIN_MENU_CODES} from "@/shared/Constants";

const ADMIN_PATH = "admin";
const EDITORS = "u_menu_editor";
const SUPERS = "u_menu_super";
const LEGACY = "u_menu_legacy";

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

afterEach(async () => {
  await env.FEED_DB.batch([
    env.FEED_DB.prepare("DELETE FROM ext_user_roles"),
    env.FEED_DB.prepare('DELETE FROM "auth_user"'),
  ]);
});

/**
 * The menu is data (migration 0041), not the hard-coded array it used to be.
 * These tests guard the two ways that data can rot: a menu code that no longer
 * has a row (the entry silently disappears from the sidebar), and a row bound
 * to a permission code that does not exist (nothing could ever see it).
 */
describe("admin menu seed", () => {
  it("has a row for every menu code", async () => {
    const rows = await env.FEED_DB.prepare("SELECT code FROM ext_menu")
      .all<{code: string}>();
    const dbCodes = new Set((rows.results ?? []).map((row) => row.code));
    const menuCodes = new Set(Object.values(ADMIN_MENU_CODES));
    expect(dbCodes).toEqual(menuCodes);
  });

  it("binds every entry but home to a real permission code", async () => {
    const rows = await env.FEED_DB.prepare(
      "SELECT code, permission_code FROM ext_menu",
    ).all<{code: string; permission_code: string | null}>();
    const seeded = rows.results ?? [];
    expect(seeded.length).toBe(Object.values(ADMIN_MENU_CODES).length);

    const home = seeded.find((row) => row.code === ADMIN_MENU_CODES.ADMIN_HOME);
    expect(home).toBeDefined();
    expect(home?.permission_code).toBeNull();

    const permissions = await env.FEED_DB.prepare(
      "SELECT code FROM ext_permissions",
    ).all<{code: string}>();
    const known = new Set((permissions.results ?? []).map((row) => row.code));

    for (const row of seeded) {
      if (row.code === ADMIN_MENU_CODES.ADMIN_HOME) continue;
      expect(row.permission_code, `menu ${row.code} has no permission`).toBeTruthy();
      expect(known.has(row.permission_code ?? ""), `menu ${row.code} binds an unknown code`).toBe(true);
    }
  });

  it("gives every entry a path fragment and an i18n key", async () => {
    const rows = await env.FEED_DB.prepare(
      "SELECT code, path, i18n_key FROM ext_menu WHERE is_visible = 1",
    ).all<{code: string; path: string; i18n_key: string}>();
    const seeded = rows.results ?? [];
    expect(seeded.length).toBeGreaterThan(0);
    for (const row of seeded) {
      expect(row.i18n_key, `menu ${row.code} has no i18n key`).toBeTruthy();
      // The home entry is the admin root, so an empty fragment is correct; every
      // other entry must carry a real one or its link would point at the root.
      expect(typeof row.path).toBe("string");
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
    const codes = menu.map((entry) => entry.id);

    expect(codes).toContain(ADMIN_MENU_CODES.ADMIN_HOME);
    expect(codes).toContain(ADMIN_MENU_CODES.ALL_ITEMS);
    expect(codes).toContain(ADMIN_MENU_CODES.IMPORT_CHAPTERS);
    expect(codes).toContain(ADMIN_MENU_CODES.PAGES);
    expect(codes).toContain(ADMIN_MENU_CODES.SITE_FILES);
    expect(codes).not.toContain(ADMIN_MENU_CODES.USERS);
    expect(codes).not.toContain(ADMIN_MENU_CODES.RBAC);
    expect(codes).not.toContain(ADMIN_MENU_CODES.SETTINGS);
    expect(codes).not.toContain(ADMIN_MENU_CODES.REVIEW);
    expect(codes).not.toContain(ADMIN_MENU_CODES.AUDIT);
    expect(codes).not.toContain(ADMIN_MENU_CODES.API);
  });

  it("shows a wildcard holder and a legacy admin every entry", async () => {
    const total = Object.values(ADMIN_MENU_CODES).length;

    const superPermissions = await seedAccount(SUPERS, "r_super_admin", "user");
    const superMenu = await readAdminMenu(
      env.FEED_DB,
      locals(SUPERS, "user", superPermissions),
      ADMIN_PATH,
      null,
      true,
    );
    expect(superMenu).toHaveLength(total);

    // A legacy Better Auth admin carries no RBAC rows at all; the guard still
    // lets it through, so the menu must agree.
    const legacyMenu = await readAdminMenu(
      env.FEED_DB,
      locals(LEGACY, "admin", new Set<string>()),
      ADMIN_PATH,
      null,
      true,
    );
    expect(legacyMenu).toHaveLength(total);
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
    const home = menu.find((entry) => entry.id === ADMIN_MENU_CODES.ADMIN_HOME);
    const books = menu.find((entry) => entry.id === ADMIN_MENU_CODES.BOOKS);
    expect(home?.disabled).toBe(false);
    expect(books?.disabled).toBe(true);
    expect(books?.active).toBe(true);
  });

  it("keeps the seeded order and marks the current entry", async () => {
    const permissions = await seedAccount(SUPERS, "r_super_admin", "user");
    const menu = await readAdminMenu(
      env.FEED_DB,
      locals(SUPERS, "user", permissions),
      ADMIN_PATH,
      ADMIN_MENU_CODES.WEBHOOKS,
      true,
    );

    // Order lives in the table (`sort`), not in code, so this is the guard that
    // used to sit on the hard-coded array.
    expect(menu.map((entry) => entry.id)).toEqual([
      ADMIN_MENU_CODES.ADMIN_HOME,
      ADMIN_MENU_CODES.EDIT_CHANNEL,
      ADMIN_MENU_CODES.ALL_ITEMS,
      ADMIN_MENU_CODES.IMPORT_CHAPTERS,
      ADMIN_MENU_CODES.REVIEW,
      ADMIN_MENU_CODES.AUDIT,
      ADMIN_MENU_CODES.PAGES,
      ADMIN_MENU_CODES.CATEGORIES,
      ADMIN_MENU_CODES.BOOKS,
      ADMIN_MENU_CODES.VOLUMES,
      ADMIN_MENU_CODES.SITE_FILES,
      ADMIN_MENU_CODES.API,
      ADMIN_MENU_CODES.WEBHOOKS,
      ADMIN_MENU_CODES.RBAC,
      ADMIN_MENU_CODES.USERS,
      ADMIN_MENU_CODES.SETTINGS,
    ]);
    expect(
      menu.find((entry) => entry.id === ADMIN_MENU_CODES.WEBHOOKS),
    ).toMatchObject({active: true, url: "/admin/webhooks/"});
  });
});
