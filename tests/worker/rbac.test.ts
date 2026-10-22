import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {STATUSES} from "@/shared/Constants";
import {BETTER_AUTH_ADMIN_ROLE, DEFAULT_USER_ROLE} from "@/shared/Rbac";
import {POST as feedPost} from "@/pages/[adminPath]/ajax/feed";

import {createMicrofeedAuth} from "@/server/auth/better-auth";
import {handleAdminBootstrap} from "@/server/auth/bootstrap";
import {
  clearMustChangePassword,
  requireAppVersion,
  requirePermission,
  requireRbac,
} from "@/server/rbac/guard";
import {
  resolveUserAccess,
  resolveUserPermissions,
  userMayEnterAdmin,
} from "@/server/rbac/resolve";
import {checkReplay} from "@/server/rbac/replay";
import {RBAC_PERMISSIONS} from "@/server/rbac/seed";
import {
  createAdminRbacRole,
  createAdminRbacUser,
  createRbacRole,
  deleteAdminRbacRole,
  deleteAdminRbacUser,
  deleteRbacRole,
  getAdminRbacUserDevices,
  getAdminRbacUsers,
  readRbacBoard,
  readRbacUserDevices,
  readRbacUsers,
  renameRbacRole,
  renameRbacRoleCode,
  replaceRolePermissions,
  replaceUserRoles,
  setRbacRoleAdminLogin,
  setRbacRoleMember,
  restoreUserDevice,
  revokeUserDevice,
  updateAdminRbacRole,
  updateAdminRbacRoleCode,
  updateAdminRbacRoleLogin,
  updateAdminRbacRoleMember,
  updateAdminRbacRoleName,
  updateAdminRbacUser,
  updateAdminRbacUserBan,
  updateAdminRbacUserDeviceRestore,
  updateAdminRbacUserDeviceRevoke,
} from "@/server/admin/rbac-handlers";

const ORIGIN = "https://feed.example.com";

async function clearRbacRows(): Promise<void> {
  await env.FEED_DB.batch([
    env.FEED_DB.prepare("DELETE FROM ext_replay_nonces"),
    env.FEED_DB.prepare("DELETE FROM ext_user_devices"),
    env.FEED_DB.prepare("DELETE FROM ext_user_security"),
    env.FEED_DB.prepare("DELETE FROM ext_user_roles"),
    env.FEED_DB.prepare('DELETE FROM "auth_user"'),
  ]);
}

async function seedUser(
  id: string,
  role: string,
): Promise<void> {
  await env.FEED_DB.prepare(
    'INSERT INTO "auth_user" (id, name, email, emailVerified, createdAt, updatedAt, role) ' +
      "VALUES (?, ?, ?, 1, '2024-01-01', '2024-01-01', ?)",
  )
    .bind(id, id.toUpperCase(), `${id}@example.com`, role)
    .run();
}

async function assignRole(userId: string, roleId: string): Promise<void> {
  await env.FEED_DB.prepare(
    "INSERT OR IGNORE INTO ext_user_roles (user_id, role_id) VALUES (?, ?)",
  )
    .bind(userId, roleId)
    .run();
}

beforeEach(clearRbacRows);

describe("RBAC permission resolution", () => {
  it("returns editor permissions (no wildcard) for an editor user", async () => {
    await seedUser("u1", "user");
    await assignRole("u1", "r_editor");
    const permissions = await resolveUserPermissions(env.FEED_DB, "u1");
    expect(permissions.has("content:book:create")).toBe(true);
    expect(permissions.has("content:category:update")).toBe(true);
    expect(permissions.has("content:volume:update")).toBe(true);
    expect(permissions.has("content:book:delete")).toBe(false);
    expect(permissions.has("*")).toBe(false);
  });

  it("resolves an empty set for a user with no roles", async () => {
    await seedUser("u2", "user");
    const permissions = await resolveUserPermissions(env.FEED_DB, "u2");
    expect(permissions.size).toBe(0);
  });

  it("会员标记按角色并集计算，没有授权行的角色也参与", async () => {
    await createRbacRole(env.FEED_DB, "member_role", "Member role");
    await createRbacRole(env.FEED_DB, "plain_role", "Plain role");
    await setRbacRoleMember(env.FEED_DB, "member_role", true);
    await seedUser("u-member", "user");
    await assignRole("u-member", "r_plain_role");
    expect((await resolveUserAccess(env.FEED_DB, "u-member")).isMember).toBe(false);

    // 再挂一个会员角色（它没有任何授权行）→ 并集为真：内连接会漏掉这种角色，
    // 所以 resolveUserAccess 用 LEFT JOIN。
    await assignRole("u-member", "r_member_role");
    expect((await resolveUserAccess(env.FEED_DB, "u-member")).isMember).toBe(true);

    await deleteRbacRole(env.FEED_DB, "member_role");
    await deleteRbacRole(env.FEED_DB, "plain_role");
  });
});

describe("requirePermission decision branches", () => {
  // `authUser` is part of the base on purpose: the ADR chain checks the session
  // first, so a wildcard grant without a session is a 401, not an ALLOW.
  const base = {
    authUser: {id: "u1"},
    rbacPermissions: new Set(["content:book:create"]),
  };

  it("allows a wildcard permission set", () => {
    const result = requirePermission(
      {...base, rbacPermissions: new Set(["*"])},
      "content:book:delete",
    );
    expect(result).toBeNull();
  });

  it("returns 401 when there is no authenticated user", () => {
    const result = requirePermission(
      {rbacPermissions: new Set(["content:book:create"])},
      "content:book:delete",
    );
    expect(result?.status).toBe(401);
  });

  it("returns 401 for a banned account, wildcard grant included", () => {
    // ADR-001 D-010 step 1: the ban is checked before any grant, so holding `*`
    // cannot keep a banned account in.
    const result = requirePermission(
      {...base, rbacBanned: true, rbacPermissions: new Set(["*"])},
      "content:book:create",
    );
    expect(result?.status).toBe(401);
  });

  it("kicks out a revoked device even for a wildcard grant", () => {
    const result = requirePermission(
      {...base, rbacDeviceRevoked: true, rbacPermissions: new Set(["*"])},
      "content:book:create",
    );
    expect(result?.status).toBe(401);
  });

  it("stops a must-change-password account even for a wildcard grant", () => {
    const result = requirePermission(
      {...base, rbacMustChangePassword: true, rbacPermissions: new Set(["*"])},
      "content:book:create",
    );
    expect(result?.status).toBe(428);
  });

  it("kicks out a revoked legacy admin (role='admin')", () => {
    const result = requirePermission(
      {...base, authUser: {id: "a1"}, rbacDeviceRevoked: true},
      "content:book:create",
    );
    expect(result?.status).toBe(401);
  });

  it("no longer lets auth_user.role='admin' authorise anything by itself", () => {
    // RBAC is the only authority: the legacy bypass is gone. An administrator
    // keeps its access through the super_admin role (migration 0053 backfills
    // it, and password-setup grants it at creation), not through this string.
    const result = requirePermission(
      {...base, authUser: {id: "a1"}},
      "content:book:delete",
    );
    expect(result?.status).toBe(403);
  });

  it("lets an adopted administrator through the super_admin grant", () => {
    const result = requirePermission(
      {
        ...base,
        authUser: {id: "a1"},
        rbacPermissions: new Set(["*"]),
      },
      "content:book:delete",
    );
    expect(result).toBeNull();
  });

  it("returns 401 when the device is revoked", () => {
    const result = requirePermission(
      {...base, rbacDeviceRevoked: true},
      "content:book:create",
    );
    expect(result?.status).toBe(401);
  });

  it("returns 428 when must-change-password and not exempt", () => {
    const result = requirePermission(
      {...base, rbacMustChangePassword: true},
      "content:book:create",
    );
    expect(result?.status).toBe(428);
  });

  it("allows the non-exempt endpoint through when exemptFromMustChange", () => {
    const result = requirePermission(
      {...base, rbacMustChangePassword: true},
      "content:book:create",
      {exemptFromMustChange: true},
    );
    expect(result).toBeNull();
  });

  it("allows when the code is in the permission set", () => {
    const result = requirePermission(base, "content:book:create");
    expect(result).toBeNull();
  });

  it("returns 403 when the code is absent and not an admin", () => {
    const result = requirePermission(base, "content:book:delete");
    expect(result?.status).toBe(403);
  });
});

describe("requireAppVersion", () => {
  // The gate now reads `ext_app_version.min_version_code` instead of a hardcoded
  // constant, and only applies to the App content namespace (ADR-0005 / §6.4).
  const APP_URL = "https://x/api/AppBookRequest/GetNav/";

  beforeEach(async () => {
    await env.FEED_DB.batch([
      env.FEED_DB.prepare("DELETE FROM ext_app_rollout"),
      env.FEED_DB.prepare(
        "UPDATE ext_app_version SET min_version_code = 10 WHERE id = 1",
      ),
    ]);
  });

  it("returns 426 when the app-version header is missing", async () => {
    const request = new Request(APP_URL, {method: "GET"});
    expect((await requireAppVersion(env.FEED_DB, request))?.status).toBe(426);
  });

  it("returns 426 for a non-integer app-version header", async () => {
    const request = new Request(APP_URL, {
      headers: {"app-version": "1.0.0"},
      method: "GET",
    });
    expect((await requireAppVersion(env.FEED_DB, request))?.status).toBe(426);
  });

  it("returns 426 for an app version below the floor", async () => {
    const request = new Request(APP_URL, {
      headers: {"app-version": "9"},
      method: "GET",
    });
    expect((await requireAppVersion(env.FEED_DB, request))?.status).toBe(426);
  });

  it("allows an app version at or above the floor", async () => {
    const request = new Request(APP_URL, {
      headers: {"app-version": "10"},
      method: "GET",
    });
    expect(await requireAppVersion(env.FEED_DB, request)).toBeNull();
  });

  it("does not gate admin/ajax requests (no app-version header)", async () => {
    const request = new Request("https://x/ajax/feed", {method: "POST"});
    const result = await requireRbac(
      {authUser: {id: "u1"}, rbacPermissions: new Set(["*"])},
      "content:book:delete",
      request,
      env.FEED_DB,
      {skipReplay: true},
    );
    expect(result).toBeNull();
  });
});

describe("requireRbac combined gate", () => {
  it("allows a wildcard admin request (web, no headers)", async () => {
    const request = new Request("https://x/ajax", {method: "POST"});
    const result = await requireRbac(
      {authUser: {id: "u1"}, rbacPermissions: new Set(["*"])},
      "content:book:delete",
      request,
      env.FEED_DB,
    );
    expect(result).toBeNull();
  });

  it("rejects a replayed request before it looks at the permission", async () => {
    // ADR-001 D-011 puts the anti-replay check ahead of the guard, so a replay
    // is a 400 even when the caller holds the permission.
    const headers = {
      "x-nonce": "replay-before-permission",
      "x-timestamp": String(Date.now()),
    };
    const first = new Request("https://x/ajax", {headers, method: "POST"});
    expect(await requireRbac(
      {authUser: {id: "u1"}, rbacPermissions: new Set(["*"])},
      "content:book:delete",
      first,
      env.FEED_DB,
    )).toBeNull();

    const second = new Request("https://x/ajax", {headers, method: "POST"});
    const replayed = await requireRbac(
      {authUser: {id: "u1"}, rbacPermissions: new Set(["*"])},
      "content:book:delete",
      second,
      env.FEED_DB,
    );
    expect(replayed?.status).toBe(400);
  });

  it("returns 403 for a non-admin user lacking the permission", async () => {
    const request = new Request("https://x/ajax", {method: "POST"});
    const result = await requireRbac(
      {
        rbacPermissions: new Set(["content:book:create"]),
        authUser: {id: "a1"},
      },
      "content:book:delete",
      request,
      env.FEED_DB,
    );
    expect(result?.status).toBe(403);
  });

  it("does not apply the app-version gate to admin endpoints (ADR-0005)", async () => {
    // The version gate now lives in the middleware's App-content branch only.
    // An admin/AJAX request carries no `app-version` header, so it must reach the
    // permission step instead of being 426'd.
    const request = new Request("https://x/ajax", {
      method: "POST",
      headers: {"app-version": "0.9.0"},
    });
    const result = await requireRbac(
      {authUser: {id: "u1"}, rbacPermissions: new Set(["*"])},
      "content:book:delete",
      request,
      env.FEED_DB,
      {skipReplay: true},
    );
    expect(result).toBeNull();
  });
});

describe("checkReplay (L2)", () => {
  function appRequest(nonce: string, timestamp: number): Request {
    return new Request("https://x/ajax", {
      method: "POST",
      headers: {
        "x-nonce": nonce,
        "x-timestamp": String(timestamp),
      },
    });
  }

  it("allows requests without the nonce pair (web admin)", async () => {
    const request = new Request("https://x/ajax", {method: "POST"});
    expect(await checkReplay(env.FEED_DB, request)).toBeNull();
  });

  it("allows a fresh nonce and rejects its reuse", async () => {
    const now = Date.now();
    const first = await checkReplay(env.FEED_DB, appRequest("n1", now));
    expect(first).toBeNull();
    const second = await checkReplay(env.FEED_DB, appRequest("n1", now));
    expect(second?.status).toBe(400);
  });

  it("rejects a non-numeric timestamp", async () => {
    const request = new Request("https://x/ajax", {
      method: "POST",
      headers: {"x-nonce": "n2", "x-timestamp": "abc"},
    });
    expect((await checkReplay(env.FEED_DB, request))?.status).toBe(400);
  });

  it("rejects a timestamp outside the 5-minute window", async () => {
    const stale = Date.now() - 10 * 60 * 1000;
    const result = await checkReplay(env.FEED_DB, appRequest("n3", stale));
    expect(result?.status).toBe(400);
  });
});

describe("RBAC catalog integrity", () => {
  it("keeps the SQL seed (migrations/0031) in sync with the code catalog", async () => {
    const rows = await env.FEED_DB.prepare("SELECT code FROM ext_permissions")
      .all<{code: string}>();
    const dbCodes = new Set((rows.results ?? []).map((r) => r.code));
    const codeCodes = new Set(RBAC_PERMISSIONS.map((p) => p.code));
    expect(dbCodes).toEqual(codeCodes);
  });

  it("seeds super_admin with the wildcard and editor with content grants", async () => {
    const editorCount = await env.FEED_DB.prepare(
      "SELECT COUNT(*) AS c FROM ext_role_permissions WHERE role_id = 'r_editor'",
    ).first<{c: number}>();
    // 13 since migration 0058 added `media:file:manage`, which A1 grants to every
    // role already holding `content:site_file:manage` (the same operator
    // audience). 14 since 0069 added `content:annotation-markers:read` — the
    // editor's rich-text editor fetches the marker list for its toolbar.
    // 15 since 0073 added `content:fang:read` — the fang board is view-only
    // (rows link out to the item editor), so the editor gains read, not update.
    // 16 since 0074 added `content:alias:read` — the alias board is read-only too.
    // 17 since 0075 added `content:alias:manage` — editors maintain the alias list.
    // 19 since 0077 added `content:yao:read` + `content:term:read` — the herb and
    // term boards are read-only too (rows link out to the item editor).
    // 21 since 0079 added `content:yao:manage` + `content:term:manage` — the
    // boards own their rows' identity / publishing state, which is content work.
    // 23 since 0119/0120 added `app:version:read` + `app:announcement:read` —
    // default-granted to the editor under the 运营管理 leaf (see migrations 0119
    // seeding the codes and 0120 granting them to the editor).
    // Bump this when a seed deliberately widens a role.
    expect(editorCount?.c).toBe(23);

    const superAdminWildcard = await env.FEED_DB.prepare(
      "SELECT COUNT(*) AS c FROM ext_role_permissions rp " +
        "JOIN ext_permissions p ON p.id = rp.permission_id " +
        "WHERE rp.role_id = 'r_super_admin' AND p.code = '*'",
    ).first<{c: number}>();
    expect(superAdminWildcard?.c).toBe(1);
  });

  it("grants readonly the same permissions as editor", async () => {
    const role = await env.FEED_DB.prepare(
      "SELECT code FROM ext_roles WHERE code = ?",
    ).bind(DEFAULT_USER_ROLE).first<{code: string}>();
    expect(role?.code).toBe(DEFAULT_USER_ROLE);

    const grantsFor = async (roleId: string): Promise<string[]> => {
      const rows = await env.FEED_DB.prepare(
        "SELECT p.code AS code FROM ext_role_permissions rp " +
          "JOIN ext_permissions p ON p.id = rp.permission_id " +
          "WHERE rp.role_id = ? ORDER BY p.code",
      ).bind(roleId).all<{code: string}>();
      return (rows.results ?? []).map((row) => row.code);
    };
    const readonly = await grantsFor("r_readonly");
    const editor = await grantsFor("r_editor");
    // 2026-10-16 起 readonly 与 editor 相同（用户要求同步；seed.ts 复用 editor 列表 +
    // migration 0122 把 editor 授权复制给 readonly）。
    expect(readonly).toEqual(editor);
    expect(readonly).toContain("content:book:create");
    expect(readonly).toContain("app:version:read");
    expect(readonly).not.toContain("*");
  });
});

describe("clearMustChangePassword", () => {
  it("clears the flag after a password change", async () => {
    await seedUser("u3", "user");
    await env.FEED_DB.prepare(
      "INSERT INTO ext_user_security (user_id, must_change_password) VALUES (?, 1)",
    ).bind("u3").run();
    await clearMustChangePassword(env.FEED_DB, "u3");
    const row = await env.FEED_DB.prepare(
      "SELECT must_change_password AS flag FROM ext_user_security WHERE user_id = ?",
    ).bind("u3").first<{flag: number}>();
    expect(row?.flag).toBe(0);
  });
});

describe("RBAC administration", () => {
  it("reads the seeded roles with their grants and the catalogue", async () => {
    const board = await readRbacBoard(env.FEED_DB, "desktop");
    const editor = board.roles.find((role) => role.code === "editor");
    // 13 since 0058 granted `media:file:manage` to the site-file managers (A1);
    // 14 since 0069 added `content:annotation-markers:read`; 15 since 0073 added
    // `content:fang:read`; 16 since 0074 added `content:alias:read`; 17 since 0075
    // added `content:alias:manage`; 19 since 0077 added `content:yao:read` +
    // `content:term:read`; 21 since 0079 added `content:yao:manage` +
    // `content:term:manage`; 23 since 0119/0120 added `app:version:read` +
    // `app:announcement:read` (default-granted to editor under 运营管理 leaf).
    // 21 on the PC console: the two App capability codes editor also holds
    // (`app:version:read`, `app:announcement:read`) belong to the App console
    // and are cropped from this board (ADR-0039 D2).
    expect(editor?.permissions).toHaveLength(21);
    expect(editor?.permissions).toContain("content:book:create");
    expect(editor?.permissions).not.toContain("content:book:delete");
    expect(board.permissions.map((entry) => entry.code)).toContain(
      "system:role:manage",
    );
    expect(board.roles.map((role) => role.code)).toContain("super_admin");

    // The permission tree is organised by the menu (migration 0052): books sits
    // under the content group and governs all four of its codes.
    const content = board.groups.find((group) => group.code === "group_content");
    const books = content?.pages.find((page) => page.code === "books");
    expect(books?.codes).toEqual([
      "content:book:create",
      "content:book:delete",
      "content:book:read",
      "content:book:update",
    ]);

    // Nothing assignable may be invisible: every catalogue code but `*` appears
    // in the tree exactly once, whether mapped to a page or parked in the
    // catch-all group.
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

  it("replaces a role's grants wholesale", async () => {
    const result = await replaceRolePermissions(env.FEED_DB, "editor", [
      "content:book:read",
      "content:category:read",
    ], "desktop");
    expect(result.ok).toBe(true);

    const board = await readRbacBoard(env.FEED_DB, "desktop");
    const editor = board.roles.find((role) => role.code === "editor");
    expect(editor?.permissions).toEqual([
      "content:book:read",
      "content:category:read",
    ]);

    // Put the seed grants back so later runs start from the seeded state.
    await replaceRolePermissions(env.FEED_DB, "editor", [
      "content:book:create",
      "content:book:read",
      "content:book:update",
      "content:category:read",
      "content:category:update",
      "content:volume:read",
      "content:volume:update",
    ], "desktop");
  });

  it("refuses to touch the wildcard role", async () => {
    // Stripping super_admin would lock every administrator out.
    const result = await replaceRolePermissions(env.FEED_DB, "super_admin", [], "desktop");
    expect(result).toEqual({ok: false, reason: "wildcardRole"});

    const board = await readRbacBoard(env.FEED_DB, "desktop");
    const superAdmin = board.roles.find((role) => role.code === "super_admin");
    expect(superAdmin?.permissions).toEqual(["*"]);
  });

  it("refuses to grant the wildcard to an ordinary role", async () => {
    // Holding `system:role:manage` must not be an escalation path to full
    // access, so the server rejects `*` even though the dashboard hides it.
    expect(await replaceRolePermissions(env.FEED_DB, "editor", ["*"], "desktop"))
      .toEqual({ok: false, reason: "wildcardPermission"});

    const board = await readRbacBoard(env.FEED_DB, "desktop");
    expect(board.roles.find((role) => role.code === "editor")?.permissions)
      .not.toContain("*");
  });

  it("rejects an unknown role and an unknown permission code", async () => {
    expect(await replaceRolePermissions(env.FEED_DB, "nope", [], "desktop"))
      .toEqual({ok: false, reason: "unknownRole"});
    expect(await replaceRolePermissions(env.FEED_DB, "editor", ["not:a:code"], "desktop"))
      .toEqual({ok: false, reason: "unknownPermission"});
  });

  it("gates the assignment write on system:role:manage", async () => {
    const body = JSON.stringify({audience: "desktop", permissions: [], role: "editor"});

    const withoutGrant = await updateAdminRbacRole({
      locals: {
        authUser: {id: "u9"},
        rbacPermissions: new Set(["content:book:read"]),
      },
      request: new Request("https://feed.example.com/admin/ajax/rbac/role-permissions", {
        body,
        method: "POST",
      }),
    } as never);
    expect(withoutGrant.status).toBe(403);

    const allowed = await updateAdminRbacRole({
      locals: {
        authUser: {id: "u9"},
        rbacPermissions: new Set(["system:role:manage"]),
      },
      request: new Request("https://feed.example.com/admin/ajax/rbac/role-permissions", {
        body,
        method: "POST",
      }),
    } as never);
    expect(allowed.status).toBe(200);

    // Restore the seeded grants.
    await replaceRolePermissions(env.FEED_DB, "editor", [
      "content:book:create",
      "content:book:read",
      "content:book:update",
      "content:category:read",
      "content:category:update",
      "content:volume:read",
      "content:volume:update",
    ], "desktop");
  });
});

/**
 * 两端控制台（ADR-0039）：一端的保存只动自己那一半 grants，跨端提交被拒，
 * 守卫码按端分派。这些用例直接读 `ext_role_permissions`，不经板子——板子本身
 * 已经按端裁过，用它断言会把「没被清掉」和「被裁掉」混在一起。
 */
describe("RBAC 两端控制台分区", () => {
  /** editor 的行级 grants（含两端），用于观察另一端是否被波及。 */
  async function grantsOf(roleCode: string): Promise<string[]> {
    const rows = await env.FEED_DB.prepare(
      "SELECT p.code AS code FROM ext_role_permissions rp " +
        "JOIN ext_roles r ON r.id = rp.role_id " +
        "JOIN ext_permissions p ON p.id = rp.permission_id " +
        "WHERE r.code = ? ORDER BY p.code",
    ).bind(roleCode).all<{code: string}>();
    return (rows.results ?? []).map((row) => row.code);
  }

  /** 把 PC 端那半恢复到「种子 + 前序用例动过的 7 条」形态，不碰 App 端。 */
  async function restoreDesktopGrants(): Promise<void> {
    await replaceRolePermissions(env.FEED_DB, "editor", [
      "content:book:create",
      "content:book:read",
      "content:book:update",
      "content:category:read",
      "content:category:update",
      "content:volume:read",
      "content:volume:update",
    ], "desktop");
  }

  it("PC 端保存不清掉 App 端授权", async () => {
    // editor 的种子里有两条 app 码（0119/0120）。PC 端整份替换若是无作用域
    // 的 `DELETE ... WHERE role_id = ?`，这两条会被顺手清掉。
    const before = await grantsOf("editor");
    expect(before).toContain("app:version:read");

    await replaceRolePermissions(env.FEED_DB, "editor", ["content:book:read"], "desktop");

    const after = await grantsOf("editor");
    expect(after.filter((code) => code.startsWith("app:")))
      .toEqual(before.filter((code) => code.startsWith("app:")));
    expect(after.filter((code) => !code.startsWith("app:")))
      .toEqual(["content:book:read"]);
    await restoreDesktopGrants();
  });

  it("App 端保存不清掉 PC 端授权", async () => {
    const before = await grantsOf("editor");
    await replaceRolePermissions(env.FEED_DB, "editor", ["app:nav:read"], "app");

    const after = await grantsOf("editor");
    // App 端那半被整份换成一条；PC 端那半一行不多、一行不少。
    expect(after.filter((code) => code.startsWith("app:")))
      .toEqual(["app:nav:read"]);
    expect(after.filter((code) => !code.startsWith("app:")))
      .toEqual(before.filter((code) => !code.startsWith("app:")));

    // 还原 App 端那半：两条 app 码，同 0119/0120 的种子形态。
    await replaceRolePermissions(
      env.FEED_DB,
      "editor",
      ["app:announcement:read", "app:version:read"],
      "app",
    );
  });

  it("跨端提交被拒且零写库", async () => {
    const direct = await replaceRolePermissions(
      env.FEED_DB,
      "editor",
      ["app:nav:read"],
      "desktop",
    );
    expect(direct).toEqual({ok: false, reason: "audienceMismatch"});

    // 端点同样拒：400，且 editor 的 grants 一行未动。
    const before = await grantsOf("editor");
    const response = await updateAdminRbacRole({
      locals: {
        authUser: {id: "u9"},
        rbacPermissions: new Set(["system:role:manage"]),
      },
      request: new Request(`${ORIGIN}/admin/ajax/rbac/role-permissions`, {
        body: JSON.stringify({
          audience: "desktop",
          permissions: ["app:nav:read"],
          role: "editor",
        }),
        method: "POST",
      }),
    } as never);
    expect(response.status).toBe(400);
    expect(await grantsOf("editor")).toEqual(before);
  });

  it("板子与目录都不含对端的码", async () => {
    const desktop = await readRbacBoard(env.FEED_DB, "desktop");
    const app = await readRbacBoard(env.FEED_DB, "app");

    const desktopCodes = desktop.permissions.map((entry) => entry.code);
    const appCodes = app.permissions.map((entry) => entry.code).sort();
    expect(desktopCodes).toContain("system:role:manage");
    expect(desktopCodes.some((code) => code.startsWith("app:"))).toBe(false);
    // App 端恰好十一个码：六个内容域 + 两个搜索 + 名词 + 版本 + 公告（0131）。
    expect(appCodes).toEqual([
      "app:announcement:read",
      "app:chapter:read",
      "app:content:read",
      "app:fang:read",
      "app:mingci:view",
      "app:nav:read",
      "app:search:book",
      "app:search:global",
      "app:style:read",
      "app:version:read",
      "app:zhongyao:read",
    ]);
    expect(appCodes).not.toContain("system:role:manage");

    // 角色行也按端裁：editor 在 App 板上只剩 app 码（种子里是版本 + 公告两条）。
    const editorOnApp = app.roles.find((role) => role.code === "editor")?.permissions ?? [];
    expect(editorOnApp).toContain("app:version:read");
    expect(editorOnApp.every((code) => code.startsWith("app:"))).toBe(true);
    // 两端的树各是一棵，互不共享分组。
    const appGroupCodes = app.groups.map((group) => group.code);
    expect(appGroupCodes).toEqual(["group_app"]);
    expect(desktop.groups.map((group) => group.code)).not.toContain("group_app");
  });

  it("只持 App 能力码可存 App 端授权，但打不开 PC 端或角色 CRUD", async () => {
    const appLocals = {
      authUser: {id: "u9"},
      rbacPermissions: new Set(["system:app-capability:manage"]),
    };
    const save = (audience: "app" | "desktop") =>
      updateAdminRbacRole({
        locals: appLocals,
        request: new Request(`${ORIGIN}/admin/ajax/rbac/role-permissions`, {
          body: JSON.stringify({
            audience,
            permissions: ["app:nav:read"],
            role: "editor",
          }),
          method: "POST",
        }),
      } as never);

    expect((await save("app")).status).toBe(200);
    // 同一个角色、同一份码，搬到 PC 端就被自己缺的那个码挡住。
    expect((await save("desktop")).status).toBe(403);

    // 角色是全局的：App 端没有建角色这条路径。
    const created = await createAdminRbacRole({
      locals: appLocals,
      request: new Request(`${ORIGIN}/admin/ajax/rbac/roles`, {
        body: JSON.stringify({code: "zz_app_role", name: "App 角色"}),
        method: "POST",
      }),
    } as never);
    expect(created.status).toBe(403);

    await replaceRolePermissions(
      env.FEED_DB,
      "editor",
      ["app:announcement:read", "app:version:read"],
      "app",
    );
  });
});

describe("RBAC user administration", () => {
  it("lists accounts with the roles granted to them", async () => {
    await seedUser("u-admin", "admin");
    await seedUser("u-writer", "user");
    await assignRole("u-writer", "r_editor");

    const board = await readRbacUsers(env.FEED_DB);
    const writer = board.users.find((entry) => entry.id === "u-writer");
    expect(writer?.roles).toEqual(["editor"]);
    expect(writer?.legacyRole).toBe("user");
    expect(writer?.banned).toBe(false);
    expect(board.roles.map((role) => role.code)).toContain("super_admin");
  });

  it("replaces an account's roles", async () => {
    await seedUser("u-swap", "user");
    expect(await replaceUserRoles(env.FEED_DB, "u-swap", ["editor"]))
      .toEqual({ok: true});

    const board = await readRbacUsers(env.FEED_DB);
    expect(board.users.find((entry) => entry.id === "u-swap")?.roles)
      .toEqual(["editor"]);

    // The swap matters: the new set replaces the old one rather than adding.
    expect(await replaceUserRoles(env.FEED_DB, "u-swap", []))
      .toEqual({ok: true});
    const after = await readRbacUsers(env.FEED_DB);
    expect(after.users.find((entry) => entry.id === "u-swap")?.roles).toEqual([]);
  });

  it("refuses to strip super_admin from the last account holding it", async () => {
    // Without this the deployment could be left with nobody able to administer
    // it, and the dashboard offers no way back in.
    await seedUser("u-only-super", "admin");
    await assignRole("u-only-super", "r_super_admin");

    expect(await replaceUserRoles(env.FEED_DB, "u-only-super", ["editor"]))
      .toEqual({ok: false, reason: "lastSuperAdmin"});

    const board = await readRbacUsers(env.FEED_DB);
    expect(board.users.find((entry) => entry.id === "u-only-super")?.roles)
      .toEqual(["super_admin"]);
  });

  it("allows dropping super_admin once a second holder exists", async () => {
    await seedUser("u-super-a", "admin");
    await seedUser("u-super-b", "admin");
    await assignRole("u-super-a", "r_super_admin");
    await assignRole("u-super-b", "r_super_admin");

    expect(await replaceUserRoles(env.FEED_DB, "u-super-a", ["editor"]))
      .toEqual({ok: true});
  });

  it("rejects an unknown account and an unknown role code", async () => {
    expect(await replaceUserRoles(env.FEED_DB, "nobody", []))
      .toEqual({ok: false, reason: "unknownUser"});
    await seedUser("u-known", "user");
    expect(await replaceUserRoles(env.FEED_DB, "u-known", ["nope"]))
      .toEqual({ok: false, reason: "unknownRole"});
  });

  it("gates the user board and the assignment write on system:user:manage", async () => {
    const get = new Request("https://feed.example.com/admin/ajax/rbac/users");

    const anonymous = await getAdminRbacUsers({locals: {}, request: get} as never);
    expect(anonymous.status).toBe(401);

    const withoutGrant = await getAdminRbacUsers({
      locals: {
        authUser: {id: "u9"},
        rbacPermissions: new Set(["system:role:manage"]),
      },
      request: get,
    } as never);
    expect(withoutGrant.status).toBe(403);

    const allowed = await getAdminRbacUsers({
      locals: {
        authUser: {id: "u9"},
        rbacPermissions: new Set(["system:user:manage"]),
      },
      request: get,
    } as never);
    expect(allowed.status).toBe(200);

    await seedUser("u-gated", "user");
    const post = () => new Request(
      "https://feed.example.com/admin/ajax/rbac/user-roles",
      {
        body: JSON.stringify({roles: ["editor"], userId: "u-gated"}),
        method: "POST",
      },
    );
    const writeWithoutGrant = await updateAdminRbacUser({
      locals: {
        authUser: {id: "u9"},
        rbacPermissions: new Set(["system:role:manage"]),
      },
      request: post(),
    } as never);
    expect(writeWithoutGrant.status).toBe(403);

    const writeAllowed = await updateAdminRbacUser({
      locals: {
        authUser: {id: "u9"},
        rbacPermissions: new Set(["system:user:manage"]),
      },
      request: post(),
    } as never);
    expect(writeAllowed.status).toBe(200);
  });
});

describe("chapter deletion permission", () => {
  // A delete arrives as a POST whose item status is DELETED, and §8.1 maps it to
  // `content:chapter:delete` — an editor who may only edit must not be able to
  // remove a chapter.
  const deletion = () => new Request(
    "https://feed.example.com/admin/ajax/feed",
    {
      body: JSON.stringify({
        item: {
          createdAtMs: 1,
          id: "any-id",
          pubDateMs: 1,
          status: STATUSES.DELETED,
          updatedAtMs: 1,
        },
      }),
      method: "POST",
    },
  );
  const withPermissions = (codes: string[]) =>
    feedPost({
      locals: {
        authUser: {id: "u9"},
        rbacPermissions: new Set(codes),
      },
      request: deletion(),
    } as never);

  it("refuses a delete for an account that may only edit", async () => {
    const response = await withPermissions(["content:chapter:update"]);
    expect(response.status).toBe(403);
  });

  it("lets the delete through once the delete permission is held", async () => {
    const response = await withPermissions(["content:chapter:delete"]);
    expect(response.status).not.toBe(403);
  });

  it("still guards ordinary edits with content:chapter:update", async () => {
    const response = await feedPost({
      locals: {
        authUser: {id: "u9"},
        rbacPermissions: new Set(["content:book:update"]),
      },
      request: new Request("https://feed.example.com/admin/ajax/feed", {
        body: JSON.stringify({item: {id: "any-id", status: STATUSES.PUBLISHED}}),
        method: "POST",
      }),
    } as never);
    expect(response.status).toBe(403);
  });
});

describe("RBAC role CRUD (pure functions)", () => {
  it("creates a role and shows it on the board", async () => {
    expect(await createRbacRole(env.FEED_DB, "reviewer", "Reviewer")).toEqual({ok: true});
    const board = await readRbacBoard(env.FEED_DB, "desktop");
    expect(board.roles.find((role) => role.code === "reviewer")?.name).toBe("Reviewer");
    // Keep the catalogue clean for later tests.
    await deleteRbacRole(env.FEED_DB, "reviewer");
  });

  it("rejects a duplicate role code", async () => {
    await createRbacRole(env.FEED_DB, "dupe_role", "Dupe");
    expect(await createRbacRole(env.FEED_DB, "dupe_role", "Dupe again"))
      .toEqual({ok: false, reason: "duplicateRole"});
    await deleteRbacRole(env.FEED_DB, "dupe_role");
  });

  it("refuses to create or touch the reserved super_admin role", async () => {
    expect(await createRbacRole(env.FEED_DB, "super_admin", "God mode"))
      .toEqual({ok: false, reason: "reservedRole"});
    expect(await renameRbacRole(env.FEED_DB, "super_admin", "Anything"))
      .toEqual({ok: false, reason: "reservedRole"});
    expect(await deleteRbacRole(env.FEED_DB, "super_admin"))
      .toEqual({ok: false, reason: "reservedRole"});
  });

  it("renames a role", async () => {
    await createRbacRole(env.FEED_DB, "rename_me", "Before");
    expect(await renameRbacRole(env.FEED_DB, "rename_me", "After")).toEqual({ok: true});
    const board = await readRbacBoard(env.FEED_DB, "desktop");
    expect(board.roles.find((role) => role.code === "rename_me")?.name).toBe("After");
    await deleteRbacRole(env.FEED_DB, "rename_me");
  });

  it("refuses to delete a role that an account still holds", async () => {
    await seedUser("u-busy", "user");
    await createRbacRole(env.FEED_DB, "busy_role", "Busy");
    await assignRole("u-busy", "r_busy_role");
    expect(await deleteRbacRole(env.FEED_DB, "busy_role"))
      .toEqual({ok: false, reason: "roleInUse"});
  });

  it("deletes a role that nobody holds", async () => {
    await createRbacRole(env.FEED_DB, "busy_role", "Busy");
    expect(await deleteRbacRole(env.FEED_DB, "busy_role")).toEqual({ok: true});
  });
});

describe("角色的「登录后台」开关", () => {
  it("新角色默认不允许，板子上带出这个字段", async () => {
    await createRbacRole(env.FEED_DB, "login_default", "Login default");
    const board = await readRbacBoard(env.FEED_DB, "desktop");
    // 0144 起新建角色默认关：需要登录后台的角色由运营显式打开。
    expect(board.roles.find((role) => role.code === "login_default")?.allowAdminLogin)
      .toBe(false);
    await deleteRbacRole(env.FEED_DB, "login_default");
  });

  it("关掉后只持该角色的账号进不了后台，多角色取并集", async () => {
    await createRbacRole(env.FEED_DB, "app_only", "App only");
    expect(await setRbacRoleAdminLogin(env.FEED_DB, "app_only", false))
      .toEqual({ok: true});
    await seedUser("u-app-only", "user");
    await assignRole("u-app-only", "r_app_only");
    expect(await userMayEnterAdmin(env.FEED_DB, "u-app-only")).toBe(false);

    // 再挂一个允许的角色（editor 默认允许）→ 并集放行。
    await assignRole("u-app-only", "r_editor");
    expect(await userMayEnterAdmin(env.FEED_DB, "u-app-only")).toBe(true);

    await env.FEED_DB.prepare(
      "DELETE FROM ext_user_roles WHERE role_id = 'r_app_only'",
    ).run();
    await deleteRbacRole(env.FEED_DB, "app_only");
  });

  it("没有角色的账号不设限", async () => {
    await seedUser("u-no-role", "user");
    expect(await userMayEnterAdmin(env.FEED_DB, "u-no-role")).toBe(true);
  });

  it("super_admin 不能被关掉，未知角色报 unknownRole", async () => {
    expect(await setRbacRoleAdminLogin(env.FEED_DB, "super_admin", false))
      .toEqual({ok: false, reason: "loginLocked"});
    expect(await setRbacRoleAdminLogin(env.FEED_DB, "nope", true))
      .toEqual({ok: false, reason: "unknownRole"});
  });

  it("改代码把这个开关一起带过去", async () => {
    await createRbacRole(env.FEED_DB, "login_a", "Login A");
    await setRbacRoleAdminLogin(env.FEED_DB, "login_a", false);
    expect(await renameRbacRoleCode(env.FEED_DB, "login_a", "login_b"))
      .toEqual({ok: true});
    const board = await readRbacBoard(env.FEED_DB, "desktop");
    expect(board.roles.find((role) => role.code === "login_b")?.allowAdminLogin)
      .toBe(false);
    await deleteRbacRole(env.FEED_DB, "login_b");
  });

  it("守卫按角色拒绝：通配授权也进不来", () => {
    const denied = requirePermission(
      {
        authUser: {id: "u1"},
        rbacAdminLoginAllowed: false,
        rbacPermissions: new Set(["*"]),
      },
      "content:book:create",
    );
    expect(denied?.status).toBe(403);
  });
});

describe("RBAC role code rename (Feature A)", () => {
  it("rebuilds the role under the new code, keeping grants and assignments", async () => {
    await createRbacRole(env.FEED_DB, "code_a", "Before");
    await replaceRolePermissions(env.FEED_DB, "code_a", ["content:book:read"], "desktop");
    // 会员标记也必须跟着改代码一起过去。
    await setRbacRoleMember(env.FEED_DB, "code_a", true);
    await seedUser("u-code-a", "user");
    await assignRole("u-code-a", "r_code_a");

    expect(await renameRbacRoleCode(env.FEED_DB, "code_a", "code_b"))
      .toEqual({ok: true});

    const board = await readRbacBoard(env.FEED_DB, "desktop");
    expect(board.roles.find((role) => role.code === "code_a")).toBeUndefined();
    const moved = board.roles.find((role) => role.code === "code_b");
    expect(moved?.name).toBe("Before");
    expect(moved?.isMember).toBe(true);
    expect(moved?.permissions).toContain("content:book:read");

    const users = await readRbacUsers(env.FEED_DB);
    expect(users.users.find((entry) => entry.id === "u-code-a")?.roles)
      .toEqual(["code_b"]);
    // Clean the catalogue for later tests.
    await deleteRbacRole(env.FEED_DB, "code_b");
  });

  it("refuses locked codes (super_admin and the default readonly role)", async () => {
    expect(await renameRbacRoleCode(env.FEED_DB, "super_admin", "god_mode"))
      .toEqual({ok: false, reason: "reservedRole"});
    expect(await renameRbacRoleCode(env.FEED_DB, DEFAULT_USER_ROLE, "reader"))
      .toEqual({ok: false, reason: "reservedRole"});
  });

  it("rejects a taken, invalid, or unknown code", async () => {
    await createRbacRole(env.FEED_DB, "code_taken", "Taken");
    expect(await renameRbacRoleCode(env.FEED_DB, "code_taken", "editor"))
      .toEqual({ok: false, reason: "duplicateRole"});
    expect(await renameRbacRoleCode(env.FEED_DB, "code_taken", "Bad Code!"))
      .toEqual({ok: false, reason: "invalidRole"});
    expect(await renameRbacRoleCode(env.FEED_DB, "does_not_exist", "fine"))
      .toEqual({ok: false, reason: "unknownRole"});
    await deleteRbacRole(env.FEED_DB, "code_taken");
  });
});

describe("RBAC role code rename endpoints (Feature A)", () => {
  const roleManage = () => ({
    authUser: {id: "u9"},
    rbacPermissions: new Set(["system:role:manage"]),
  });

  it("gates the rename on system:role:manage and refuses a locked code", async () => {
    await createRbacRole(env.FEED_DB, "code_ep", "Endpoint");

    const anonymous = await updateAdminRbacRoleCode({
      locals: {},
      request: new Request("https://feed.example.com/admin/ajax/rbac/role-code", {
        body: JSON.stringify({code: "code_ep", newCode: "code_ep2"}),
        headers: {"content-type": "application/json"},
        method: "POST",
      }),
    } as never);
    expect(anonymous.status).toBe(401);

    const ok = await updateAdminRbacRoleCode({
      locals: roleManage(),
      request: new Request("https://feed.example.com/admin/ajax/rbac/role-code", {
        body: JSON.stringify({code: "code_ep", newCode: "code_ep2"}),
        headers: {"content-type": "application/json"},
        method: "POST",
      }),
    } as never);
    expect(ok.status).toBe(200);
    const board = await ok.json() as Awaited<ReturnType<typeof readRbacBoard>>;
    expect(board.roles.find((role) => role.code === "code_ep2")?.name).toBe("Endpoint");

    const locked = await updateAdminRbacRoleCode({
      locals: roleManage(),
      request: new Request("https://feed.example.com/admin/ajax/rbac/role-code", {
        body: JSON.stringify({code: DEFAULT_USER_ROLE, newCode: "reader"}),
        headers: {"content-type": "application/json"},
        method: "POST",
      }),
    } as never);
    expect(locked.status).toBe(400);
    await deleteRbacRole(env.FEED_DB, "code_ep2");
  });
});

describe("RBAC role CRUD endpoints", () => {
  function roleRequest(code: string, name: string): Request {
    return new Request("https://feed.example.com/admin/ajax/rbac/roles", {
      body: JSON.stringify({code, name}),
      headers: {"content-type": "application/json"},
      method: "POST",
    });
  }

  it("gates create on system:role:manage (401 / 403 / 200)", async () => {
    const anonymous = await createAdminRbacRole({locals: {}, request: roleRequest("x", "X")} as never);
    expect(anonymous.status).toBe(401);

    const forbidden = await createAdminRbacRole({
      locals: {
        authUser: {id: "u9"},
        rbacPermissions: new Set(["content:book:read"]),
      },
      request: roleRequest("x", "X"),
    } as never);
    expect(forbidden.status).toBe(403);

    const allowed = await createAdminRbacRole({
      locals: {
        authUser: {id: "u9"},
        rbacPermissions: new Set(["system:role:manage"]),
      },
      request: roleRequest("endpoint_role", "Endpoint"),
    } as never);
    expect(allowed.status).toBe(200);
    const board = await allowed.json() as Awaited<ReturnType<typeof readRbacBoard>>;
    const created = board.roles.find((role) => role.code === "endpoint_role");
    expect(created?.name).toBe("Endpoint");
    // 0144 起：新建角色默认不允许登录后台、默认不是会员。
    expect(created?.allowAdminLogin).toBe(false);
    expect(created?.isMember).toBe(false);
    await deleteRbacRole(env.FEED_DB, "endpoint_role");
  });

  it("rejects an invalid role code with 400", async () => {
    const response = await createAdminRbacRole({
      locals: {
        authUser: {id: "u9"},
        rbacPermissions: new Set(["system:role:manage"]),
      },
      request: roleRequest("Bad Code!", "Bad"),
    } as never);
    expect(response.status).toBe(400);
  });

  it("renames via the endpoint and refuses the reserved role", async () => {
    await createRbacRole(env.FEED_DB, "rename_ep", "Start");
    const ok = await updateAdminRbacRoleName({
      locals: {
        authUser: {id: "u9"},
        rbacPermissions: new Set(["system:role:manage"]),
      },
      request: new Request("https://feed.example.com/admin/ajax/rbac/role-name", {
        body: JSON.stringify({code: "rename_ep", name: "Renamed"}),
        headers: {"content-type": "application/json"},
        method: "POST",
      }),
    } as never);
    expect(ok.status).toBe(200);
    const board = await ok.json() as Awaited<ReturnType<typeof readRbacBoard>>;
    expect(board.roles.find((role) => role.code === "rename_ep")?.name).toBe("Renamed");

    const reserved = await updateAdminRbacRoleName({
      locals: {
        authUser: {id: "u9"},
        rbacPermissions: new Set(["system:role:manage"]),
      },
      request: new Request("https://feed.example.com/admin/ajax/rbac/role-name", {
        body: JSON.stringify({code: "super_admin", name: "Nope"}),
        headers: {"content-type": "application/json"},
        method: "POST",
      }),
    } as never);
    expect(reserved.status).toBe(400);
    await deleteRbacRole(env.FEED_DB, "rename_ep");
  });

  it("deletes via the endpoint and refuses the reserved role", async () => {
    await createRbacRole(env.FEED_DB, "delete_ep", "To go");
    const ok = await deleteAdminRbacRole({
      locals: {
        authUser: {id: "u9"},
        rbacPermissions: new Set(["system:role:manage"]),
      },
      request: new Request("https://feed.example.com/admin/ajax/rbac/role-delete", {
        body: JSON.stringify({code: "delete_ep"}),
        headers: {"content-type": "application/json"},
        method: "POST",
      }),
    } as never);
    expect(ok.status).toBe(200);
    const board = await ok.json() as Awaited<ReturnType<typeof readRbacBoard>>;
    expect(board.roles.find((role) => role.code === "delete_ep")).toBeUndefined();

    const reserved = await deleteAdminRbacRole({
      locals: {
        authUser: {id: "u9"},
        rbacPermissions: new Set(["system:role:manage"]),
      },
      request: new Request("https://feed.example.com/admin/ajax/rbac/role-delete", {
        body: JSON.stringify({code: "super_admin"}),
        headers: {"content-type": "application/json"},
        method: "POST",
      }),
    } as never);
    expect(reserved.status).toBe(409);
  });

  it("toggles the admin sign-in switch through the endpoint", async () => {
    await createRbacRole(env.FEED_DB, "login_ep", "Login ep");
    const loginRequest = (body: unknown) =>
      new Request("https://feed.example.com/admin/ajax/rbac/role-login", {
        body: JSON.stringify(body),
        headers: {"content-type": "application/json"},
        method: "POST",
      });

    // 同一道门：没有会话 401，有会话但缺码 403。
    const anonymous = await updateAdminRbacRoleLogin({
      locals: {},
      request: loginRequest({allow: false, code: "login_ep"}),
    } as never);
    expect(anonymous.status).toBe(401);
    const forbidden = await updateAdminRbacRoleLogin({
      locals: {authUser: {id: "u9"}, rbacPermissions: new Set(["content:book:read"])},
      request: loginRequest({allow: false, code: "login_ep"}),
    } as never);
    expect(forbidden.status).toBe(403);

    const ok = await updateAdminRbacRoleLogin({
      locals: {
        authUser: {id: "u9"},
        rbacPermissions: new Set(["system:role:manage"]),
      },
      request: loginRequest({allow: false, code: "login_ep"}),
    } as never);
    expect(ok.status).toBe(200);
    const board = await ok.json() as Awaited<ReturnType<typeof readRbacBoard>>;
    expect(board.roles.find((role) => role.code === "login_ep")?.allowAdminLogin)
      .toBe(false);

    // 字符串 "false" 是真值：放过它会把「不允许」静默存成允许。
    const notBoolean = await updateAdminRbacRoleLogin({
      locals: {
        authUser: {id: "u9"},
        rbacPermissions: new Set(["system:role:manage"]),
      },
      request: loginRequest({allow: "false", code: "login_ep"}),
    } as never);
    expect(notBoolean.status).toBe(400);

    // super_admin 固定为允许：关不掉，板子上仍是允许。
    const locked = await updateAdminRbacRoleLogin({
      locals: {
        authUser: {id: "u9"},
        rbacPermissions: new Set(["system:role:manage"]),
      },
      request: loginRequest({allow: false, code: "super_admin"}),
    } as never);
    expect(locked.status).toBe(400);
    const afterLock = await readRbacBoard(env.FEED_DB, "desktop");
    expect(afterLock.roles.find((role) => role.code === "super_admin")?.allowAdminLogin)
      .toBe(true);

    await deleteRbacRole(env.FEED_DB, "login_ep");
  });

  it("toggles the member flag through the endpoint", async () => {
    await createRbacRole(env.FEED_DB, "member_ep", "Member ep");
    const memberRequest = (body: unknown) =>
      new Request("https://feed.example.com/admin/ajax/rbac/role-member", {
        body: JSON.stringify(body),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
    const manage = {
      authUser: {id: "u9"},
      rbacPermissions: new Set(["system:role:manage"]),
    };

    // 新建角色默认不是会员。
    const created = await readRbacBoard(env.FEED_DB, "desktop");
    expect(created.roles.find((role) => role.code === "member_ep")?.isMember).toBe(false);

    // 同一道门：没有会话 401，有会话但缺码 403。
    const anonymous = await updateAdminRbacRoleMember({
      locals: {},
      request: memberRequest({code: "member_ep", member: true}),
    } as never);
    expect(anonymous.status).toBe(401);
    const forbidden = await updateAdminRbacRoleMember({
      locals: {authUser: {id: "u9"}, rbacPermissions: new Set(["content:book:read"])},
      request: memberRequest({code: "member_ep", member: true}),
    } as never);
    expect(forbidden.status).toBe(403);

    const ok = await updateAdminRbacRoleMember({
      locals: manage,
      request: memberRequest({code: "member_ep", member: true}),
    } as never);
    expect(ok.status).toBe(200);
    const board = await ok.json() as Awaited<ReturnType<typeof readRbacBoard>>;
    expect(board.roles.find((role) => role.code === "member_ep")?.isMember).toBe(true);

    // 只认布尔：字符串 "true" 不能静默存成会员。
    const notBoolean = await updateAdminRbacRoleMember({
      locals: manage,
      request: memberRequest({code: "member_ep", member: "true"}),
    } as never);
    expect(notBoolean.status).toBe(400);

    const missing = await updateAdminRbacRoleMember({
      locals: manage,
      request: memberRequest({code: "ghost", member: true}),
    } as never);
    expect(missing.status).toBe(404);

    await deleteRbacRole(env.FEED_DB, "member_ep");
  });
});

describe("RBAC user CRUD endpoints", () => {
  const userManage = (codes: string[]) => ({
    authUser: {id: "u9"},
    rbacPermissions: new Set(codes),
  });

  it("gates create / ban / delete on system:user:manage", async () => {
    const noSession = {locals: {}, request: new Request("https://feed.example.com/admin/ajax/rbac/user-create", {
      body: JSON.stringify({email: "a@b.com", name: "A", password: "password123"}),
      headers: {"content-type": "application/json"},
      method: "POST",
    })} as never;
    expect((await createAdminRbacUser(noSession)).status).toBe(401);

    const forbidden = {
      locals: userManage(["content:book:read"]),
      request: new Request("https://feed.example.com/admin/ajax/rbac/user-create", {
        body: JSON.stringify({email: "a@b.com", name: "A", password: "password123"}),
        headers: {"content-type": "application/json"},
        method: "POST",
      }),
    } as never;
    expect((await createAdminRbacUser(forbidden)).status).toBe(403);

    const banForbidden = {
      locals: userManage(["content:book:read"]),
      request: new Request("https://feed.example.com/admin/ajax/rbac/user-ban", {
        body: JSON.stringify({banned: true, userId: "u1"}),
        headers: {"content-type": "application/json"},
        method: "POST",
      }),
    } as never;
    expect((await updateAdminRbacUserBan(banForbidden)).status).toBe(403);

    const delForbidden = {
      locals: userManage(["content:book:read"]),
      request: new Request("https://feed.example.com/admin/ajax/rbac/user-delete", {
        body: JSON.stringify({userId: "u1"}),
        headers: {"content-type": "application/json"},
        method: "POST",
      }),
    } as never;
    expect((await deleteAdminRbacUser(delForbidden)).status).toBe(403);
  });

  it("rejects malformed create / ban / delete bodies before touching Better Auth", async () => {
    const grant = userManage(["system:user:manage"]);
    const shortPassword = {
      locals: grant,
      request: new Request("https://feed.example.com/admin/ajax/rbac/user-create", {
        body: JSON.stringify({email: "a@b.com", name: "A", password: "short"}),
        headers: {"content-type": "application/json"},
        method: "POST",
      }),
    } as never;
    expect((await createAdminRbacUser(shortPassword)).status).toBe(400);

    const missingUserId = {
      locals: grant,
      request: new Request("https://feed.example.com/admin/ajax/rbac/user-delete", {
        body: JSON.stringify({}),
        headers: {"content-type": "application/json"},
        method: "POST",
      }),
    } as never;
    expect((await deleteAdminRbacUser(missingUserId)).status).toBe(400);

    const badBanBody = {
      locals: grant,
      request: new Request("https://feed.example.com/admin/ajax/rbac/user-ban", {
        body: JSON.stringify({banned: "yes", userId: "u1"}),
        headers: {"content-type": "application/json"},
        method: "POST",
      }),
    } as never;
    expect((await updateAdminRbacUserBan(badBanBody)).status).toBe(400);
  });

  it("returns 404 when deleting an unknown account", async () => {
    const response = await deleteAdminRbacUser({
      locals: userManage(["system:user:manage"]),
      request: new Request("https://feed.example.com/admin/ajax/rbac/user-delete", {
        body: JSON.stringify({userId: "does-not-exist"}),
        headers: {"content-type": "application/json"},
        method: "POST",
      }),
    } as never);
    expect(response.status).toBe(404);
  });

  it("creates, bans, and deletes an account through Better Auth", async () => {
    // The lifecycle endpoints delegate to Better Auth's admin plugin, so the
    // request must carry an administrator session.
    await handleAdminBootstrap(
      {
        FEED_DB: env.FEED_DB,
        MICROFEED_SETUP_ADMIN_EMAIL: "admin@example.com",
        MICROFEED_SETUP_ADMIN_PASSWORD: "Correct horse battery staple",
        MICROFEED_SETUP_ADMIN_PASSWORD_CONFIRMATION: "Correct horse battery staple",
      },
      new Request(`${ORIGIN}/.well-known/microfeed/bootstrap-admin/`, {method: "POST"}),
    );
    const signIn = await createMicrofeedAuth(env, new Request(
      `${ORIGIN}/api/auth/sign-in/email`,
      {
        body: JSON.stringify({email: "admin@example.com", password: "Correct horse battery staple"}),
        headers: {"content-type": "application/json", origin: ORIGIN},
        method: "POST",
      },
    )).handler(new Request(
      `${ORIGIN}/api/auth/sign-in/email`,
      {
        body: JSON.stringify({email: "admin@example.com", password: "Correct horse battery staple"}),
        headers: {"content-type": "application/json", origin: ORIGIN},
        method: "POST",
      },
    ));
    const cookie = (signIn.headers.getSetCookie?.() ?? []).join("; ");
    expect(cookie).toBeTruthy();

    const withSession = (path: string, body: unknown) => new Request(
      `${ORIGIN}/admin/ajax/rbac/${path}`,
      {
        body: JSON.stringify(body),
        headers: {cookie, "content-type": "application/json"},
        method: "POST",
      },
    );

    const created = await createAdminRbacUser({
      locals: userManage(["system:user:manage"]),
      request: withSession("user-create", {
        email: "created@example.com",
        name: "Created",
        password: "Created password",
      }),
    } as never);
    expect(created.status).toBe(200);
    const afterCreate = await created.json() as Awaited<ReturnType<typeof readRbacUsers>>;
    const newUser = afterCreate.users.find((entry) => entry.email === "created@example.com");
    expect(newUser).toBeTruthy();
    expect(newUser?.banned).toBe(false);

    // This deployment does not force a password change on first sign-in, so a
    // freshly created account must NOT carry the flag (migration 0042 also
    // clears it for accounts created under the old behaviour).
    const security = await env.FEED_DB.prepare(
      "SELECT must_change_password AS flag FROM ext_user_security WHERE user_id = ?",
    ).bind(newUser?.id).first<{flag: number} | null>();
    expect(security?.flag ?? 0).toBe(0);

    // The request sent no `roles`, so the account falls back to the read-only
    // default rather than being created permission-less.
    expect(newUser?.roles).toEqual([DEFAULT_USER_ROLE]);

    // B1: a freshly created account whose RBAC role is super_admin must mirror
    // that onto `auth_user.role`, so Better Auth's own admin gate (which reads
    // that column) stays consistent with RBAC instead of leaving a stale "user".
    const superCreated = await createAdminRbacUser({
      locals: userManage(["system:user:manage"]),
      request: withSession("user-create", {
        email: "super@example.com",
        name: "Super",
        password: "Super password",
        roles: ["super_admin"],
      }),
    } as never);
    expect(superCreated.status).toBe(200);
    const superJson = await superCreated.json() as Awaited<ReturnType<typeof readRbacUsers>>;
    const superUser = superJson.users.find((entry) => entry.email === "super@example.com");
    expect(superUser).toBeTruthy();
    const mirrored = await env.FEED_DB.prepare(
      'SELECT role FROM "auth_user" WHERE id = ?',
    ).bind(superUser?.id).first<{role: string} | null>();
    expect(mirrored?.role).toBe(BETTER_AUTH_ADMIN_ROLE);

    const superDeleted = await deleteAdminRbacUser({
      locals: userManage(["system:user:manage"]),
      request: withSession("user-delete", {userId: superUser?.id}),
    } as never);
    expect(superDeleted.status).toBe(200);

    const banned = await updateAdminRbacUserBan({
      locals: userManage(["system:user:manage"]),
      request: withSession("user-ban", {banned: true, userId: newUser?.id}),
    } as never);
    expect(banned.status).toBe(200);
    const afterBan = await banned.json() as Awaited<ReturnType<typeof readRbacUsers>>;
    expect(afterBan.users.find((entry) => entry.id === newUser?.id)?.banned).toBe(true);

    const deleted = await deleteAdminRbacUser({
      locals: userManage(["system:user:manage"]),
      request: withSession("user-delete", {userId: newUser?.id}),
    } as never);
    expect(deleted.status).toBe(200);
    const afterDelete = await deleted.json() as Awaited<ReturnType<typeof readRbacUsers>>;
    expect(afterDelete.users.find((entry) => entry.id === newUser?.id)).toBeUndefined();
  });
});

describe("RBAC device administration (Gap E)", () => {
  async function seedDevice(userId: string, deviceId: string, status = "active"): Promise<void> {
    await env.FEED_DB.prepare(
      "INSERT INTO ext_user_devices (user_id, device_id, last_seen_at, status) VALUES (?, ?, '2024-01-01', ?)",
    ).bind(userId, deviceId, status).run();
  }

  it("revokes and restores a device (pure functions)", async () => {
    await seedUser("u-dev", "user");
    await seedDevice("u-dev", "device-a", "active");

    expect(await revokeUserDevice(env.FEED_DB, "u-dev", "device-a")).toEqual({ok: true});
    const revoked = await env.FEED_DB.prepare(
      "SELECT status FROM ext_user_devices WHERE user_id = ? AND device_id = ?",
    ).bind("u-dev", "device-a").first<{status: string}>();
    expect(revoked?.status).toBe("revoked");

    // The guard reads this flag, so a revoked device now 401s (the gap is closed).
    expect(await restoreUserDevice(env.FEED_DB, "u-dev", "device-a")).toEqual({ok: true});
    const restored = await env.FEED_DB.prepare(
      "SELECT status FROM ext_user_devices WHERE user_id = ? AND device_id = ?",
    ).bind("u-dev", "device-a").first<{status: string}>();
    expect(restored?.status).toBe("active");
  });

  it("refuses an unknown account or device", async () => {
    await seedUser("u-dev2", "user");
    await seedDevice("u-dev2", "device-b");
    expect(await revokeUserDevice(env.FEED_DB, "nope", "device-b"))
      .toEqual({ok: false, reason: "unknownUser"});
    expect(await revokeUserDevice(env.FEED_DB, "u-dev2", "nope"))
      .toEqual({ok: false, reason: "unknownDevice"});
  });

  it("lists a user's devices", async () => {
    await seedUser("u-dev3", "user");
    await seedDevice("u-dev3", "device-c");
    const devices = await readRbacUserDevices(env.FEED_DB, "u-dev3");
    expect(devices).toHaveLength(1);
    expect(devices[0]?.deviceId).toBe("device-c");
    expect(devices[0]?.status).toBe("active");
  });

  const userManage = (codes: string[]) => ({
    authUser: {id: "u9"},
    rbacPermissions: new Set(codes),
  });

  it("gates the device endpoints on system:user:manage (401 / 403 / 200)", async () => {
    await seedUser("u-dev4", "user");
    await seedDevice("u-dev4", "device-d");

    const listAnonymous = await getAdminRbacUserDevices({
      locals: {},
      request: new Request("https://feed.example.com/admin/ajax/rbac/user-devices?userId=u-dev4"),
    } as never);
    expect(listAnonymous.status).toBe(401);

    const listForbidden = await getAdminRbacUserDevices({
      locals: userManage(["content:book:read"]),
      request: new Request("https://feed.example.com/admin/ajax/rbac/user-devices?userId=u-dev4"),
    } as never);
    expect(listForbidden.status).toBe(403);

    const listAllowed = await getAdminRbacUserDevices({
      locals: userManage(["system:user:manage"]),
      request: new Request("https://feed.example.com/admin/ajax/rbac/user-devices?userId=u-dev4"),
    } as never);
    expect(listAllowed.status).toBe(200);

    const revokeMissing = await updateAdminRbacUserDeviceRevoke({
      locals: userManage(["system:user:manage"]),
      request: new Request("https://feed.example.com/admin/ajax/rbac/user-device-revoke", {
        body: JSON.stringify({userId: "u-dev4"}),
        headers: {"content-type": "application/json"},
        method: "POST",
      }),
    } as never);
    expect(revokeMissing.status).toBe(400);

    const revokeUnknown = await updateAdminRbacUserDeviceRevoke({
      locals: userManage(["system:user:manage"]),
      request: new Request("https://feed.example.com/admin/ajax/rbac/user-device-revoke", {
        body: JSON.stringify({deviceId: "nope", userId: "u-dev4"}),
        headers: {"content-type": "application/json"},
        method: "POST",
      }),
    } as never);
    expect(revokeUnknown.status).toBe(404);

    const revokeOk = await updateAdminRbacUserDeviceRevoke({
      locals: userManage(["system:user:manage"]),
      request: new Request("https://feed.example.com/admin/ajax/rbac/user-device-revoke", {
        body: JSON.stringify({deviceId: "device-d", userId: "u-dev4"}),
        headers: {"content-type": "application/json"},
        method: "POST",
      }),
    } as never);
    expect(revokeOk.status).toBe(200);
    const afterRevoke = await revokeOk.json() as Awaited<ReturnType<typeof readRbacUserDevices>>;
    expect(afterRevoke.find((entry) => entry.deviceId === "device-d")?.status).toBe("revoked");

    const restoreOk = await updateAdminRbacUserDeviceRestore({
      locals: userManage(["system:user:manage"]),
      request: new Request("https://feed.example.com/admin/ajax/rbac/user-device-restore", {
        body: JSON.stringify({deviceId: "device-d", userId: "u-dev4"}),
        headers: {"content-type": "application/json"},
        method: "POST",
      }),
    } as never);
    expect(restoreOk.status).toBe(200);
    const afterRestore = await restoreOk.json() as Awaited<ReturnType<typeof readRbacUserDevices>>;
    expect(afterRestore.find((entry) => entry.deviceId === "device-d")?.status).toBe("active");
  });
});

describe("RBAC audit trail", () => {
  it("records who changed a role's permissions", async () => {
    await createRbacRole(env.FEED_DB, "audit_probe", "Audit probe");

    const response = await updateAdminRbacRole({
      locals: {
        authUser: {email: "owner@example.com", id: "u9"},
        rbacPermissions: new Set(["system:role:manage"]),
      },
      request: new Request("https://feed.example.com/admin/ajax/rbac/role-permissions", {
        body: JSON.stringify({
          audience: "desktop",
          permissions: ["content:book:read"],
          role: "audit_probe",
        }),
        headers: {"content-type": "application/json"},
        method: "POST",
      }),
    } as never);
    expect(response.status).toBe(200);

    // Role and permission changes used to leave no trace at all; this is the
    // row that answers "who gave that role this permission?".
    const row = await env.FEED_DB.prepare(
      "SELECT action, actor_label, before_detail, detail, target " +
        "FROM ext_rbac_audit ORDER BY created_at_ms DESC LIMIT 1",
    ).first<{
      action: string;
      actor_label: string | null;
      before_detail: string | null;
      detail: string | null;
      target: string | null;
    }>();
    expect(row).toMatchObject({
      action: "role.permissions",
      actor_label: "owner@example.com",
      // The role was freshly created, so it had no grants — and the row still
      // answers "what did it change from?", which is the whole point.
      before_detail: "",
      detail: "content:book:read",
      target: "audit_probe",
    });

    await deleteRbacRole(env.FEED_DB, "audit_probe");
    await env.FEED_DB.prepare("DELETE FROM ext_rbac_audit").run();
  });
});
