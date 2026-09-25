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
import {resolveUserPermissions} from "@/server/rbac/resolve";
import {checkReplay} from "@/server/rbac/replay";
import {RBAC_PERMISSIONS} from "@/server/rbac/seed";
import {
  createAdminRbacRole,
  createAdminRbacUser,
  createRbacRole,
  deleteAdminRbacRole,
  deleteAdminRbacUser,
  deleteRbacRole,
  getAdminRbacBoard,
  getAdminRbacUserDevices,
  getAdminRbacUsers,
  readRbacBoard,
  readRbacUserDevices,
  readRbacUsers,
  renameRbacRole,
  renameRbacRoleCode,
  replaceRolePermissions,
  replaceUserRoles,
  restoreUserDevice,
  revokeUserDevice,
  updateAdminRbacRole,
  updateAdminRbacRoleCode,
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
  it("skips the gate when no App-Version header (web admin)", () => {
    const request = new Request("https://x/ajax", {method: "POST"});
    expect(requireAppVersion(request)).toBeNull();
  });

  it("returns 426 for an app version below the minimum", () => {
    const request = new Request("https://x/ajax", {
      method: "POST",
      headers: {"app-version": "0.9.0"},
    });
    expect(requireAppVersion(request)?.status).toBe(426);
  });

  it("allows an app version at or above the minimum", () => {
    const request = new Request("https://x/ajax", {
      method: "POST",
      headers: {"app-version": "1.0.0"},
    });
    expect(requireAppVersion(request)).toBeNull();
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

  it("returns 426 for an outdated app version before checking permissions", async () => {
    const request = new Request("https://x/ajax", {
      method: "POST",
      headers: {"app-version": "0.9.0"},
    });
    const result = await requireRbac(
      {rbacPermissions: new Set(["*"])},
      "content:book:delete",
      request,
      env.FEED_DB,
      {skipReplay: true},
    );
    expect(result?.status).toBe(426);
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
    expect(editorCount?.c).toBe(12);

    const superAdminWildcard = await env.FEED_DB.prepare(
      "SELECT COUNT(*) AS c FROM ext_role_permissions rp " +
        "JOIN ext_permissions p ON p.id = rp.permission_id " +
        "WHERE rp.role_id = 'r_super_admin' AND p.code = '*'",
    ).first<{c: number}>();
    expect(superAdminWildcard?.c).toBe(1);
  });

  it("seeds the read-only role granted only content read codes", async () => {
    const role = await env.FEED_DB.prepare(
      "SELECT code FROM ext_roles WHERE code = ?",
    ).bind(DEFAULT_USER_ROLE).first<{code: string}>();
    expect(role?.code).toBe(DEFAULT_USER_ROLE);

    const grants = await env.FEED_DB.prepare(
      "SELECT p.code AS code FROM ext_role_permissions rp " +
        "JOIN ext_permissions p ON p.id = rp.permission_id " +
        "WHERE rp.role_id = 'r_readonly' ORDER BY p.code",
    ).all<{code: string}>();
    expect((grants.results ?? []).map((row) => row.code)).toEqual([
      // Alphabetical by code (the query orders by code).
      "content:book:read",
      "content:category:read",
      "content:chapter:read",
      "content:volume:read",
    ]);
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
    const board = await readRbacBoard(env.FEED_DB);
    const editor = board.roles.find((role) => role.code === "editor");
    expect(editor?.permissions).toHaveLength(12);
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
    ]);
    expect(result.ok).toBe(true);

    const board = await readRbacBoard(env.FEED_DB);
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
    ]);
  });

  it("refuses to touch the wildcard role", async () => {
    // Stripping super_admin would lock every administrator out.
    const result = await replaceRolePermissions(env.FEED_DB, "super_admin", []);
    expect(result).toEqual({ok: false, reason: "wildcardRole"});

    const board = await readRbacBoard(env.FEED_DB);
    const superAdmin = board.roles.find((role) => role.code === "super_admin");
    expect(superAdmin?.permissions).toEqual(["*"]);
  });

  it("refuses to grant the wildcard to an ordinary role", async () => {
    // Holding `system:permission:manage` must not be an escalation path to
    // full access, so the server rejects `*` even though the dashboard hides it.
    expect(await replaceRolePermissions(env.FEED_DB, "editor", ["*"]))
      .toEqual({ok: false, reason: "wildcardPermission"});

    const board = await readRbacBoard(env.FEED_DB);
    expect(board.roles.find((role) => role.code === "editor")?.permissions)
      .not.toContain("*");
  });

  it("rejects an unknown role and an unknown permission code", async () => {
    expect(await replaceRolePermissions(env.FEED_DB, "nope", []))
      .toEqual({ok: false, reason: "unknownRole"});
    expect(await replaceRolePermissions(env.FEED_DB, "editor", ["not:a:code"]))
      .toEqual({ok: false, reason: "unknownPermission"});
  });

  it("gates the board on system:role:manage", async () => {
    const request = new Request("https://feed.example.com/admin/ajax/rbac");

    const anonymous = await getAdminRbacBoard({
      locals: {},
      request,
    } as never);
    expect(anonymous.status).toBe(401);

    const withoutGrant = await getAdminRbacBoard({
      locals: {
        authUser: {id: "u9"},
        rbacPermissions: new Set(["content:book:read"]),
      },
      request,
    } as never);
    expect(withoutGrant.status).toBe(403);

    const allowed = await getAdminRbacBoard({
      locals: {
        authUser: {id: "u9"},
        rbacPermissions: new Set(["system:role:manage"]),
      },
      request,
    } as never);
    expect(allowed.status).toBe(200);
  });

  it("gates the assignment write on system:permission:manage", async () => {
    const body = JSON.stringify({permissions: [], role: "editor"});

    const withoutGrant = await updateAdminRbacRole({
      locals: {
        authUser: {id: "u9"},
        rbacPermissions: new Set(["system:role:manage"]),
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
        rbacPermissions: new Set(["system:permission:manage"]),
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
    ]);
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
    const board = await readRbacBoard(env.FEED_DB);
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
    const board = await readRbacBoard(env.FEED_DB);
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

describe("RBAC role code rename (Feature A)", () => {
  it("rebuilds the role under the new code, keeping grants and assignments", async () => {
    await createRbacRole(env.FEED_DB, "code_a", "Before");
    await replaceRolePermissions(env.FEED_DB, "code_a", ["content:book:read"]);
    await seedUser("u-code-a", "user");
    await assignRole("u-code-a", "r_code_a");

    expect(await renameRbacRoleCode(env.FEED_DB, "code_a", "code_b"))
      .toEqual({ok: true});

    const board = await readRbacBoard(env.FEED_DB);
    expect(board.roles.find((role) => role.code === "code_a")).toBeUndefined();
    const moved = board.roles.find((role) => role.code === "code_b");
    expect(moved?.name).toBe("Before");
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
    expect(board.roles.find((role) => role.code === "endpoint_role")?.name).toBe("Endpoint");
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
        rbacPermissions: new Set(["system:permission:manage"]),
      },
      request: new Request("https://feed.example.com/admin/ajax/rbac/role-permissions", {
        body: JSON.stringify({
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
