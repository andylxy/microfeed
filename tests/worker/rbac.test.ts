import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

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
  getAdminRbacBoard,
  readRbacBoard,
  replaceRolePermissions,
  updateAdminRbacRole,
} from "@/server/admin/rbac-handlers";

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
    authUser: {id: "u1", role: null},
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
      "x",
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
      {...base, authUser: {id: "a1", role: "admin"}, rbacDeviceRevoked: true},
      "content:book:create",
    );
    expect(result?.status).toBe(401);
  });

  it("allows legacy Better Auth admins regardless of grants (upgrade safety)", () => {
    const result = requirePermission(
      {...base, authUser: {id: "a1", role: "admin"}},
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
      {authUser: {id: "u1", role: null}, rbacPermissions: new Set(["*"])},
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
      {authUser: {id: "u1", role: null}, rbacPermissions: new Set(["*"])},
      "content:book:delete",
      first,
      env.FEED_DB,
    )).toBeNull();

    const second = new Request("https://x/ajax", {headers, method: "POST"});
    const replayed = await requireRbac(
      {authUser: {id: "u1", role: null}, rbacPermissions: new Set(["*"])},
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
    expect(editorCount?.c).toBe(7);

    const superAdminWildcard = await env.FEED_DB.prepare(
      "SELECT COUNT(*) AS c FROM ext_role_permissions rp " +
        "JOIN ext_permissions p ON p.id = rp.permission_id " +
        "WHERE rp.role_id = 'r_super_admin' AND p.code = '*'",
    ).first<{c: number}>();
    expect(superAdminWildcard?.c).toBe(1);
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
    expect(editor?.permissions).toHaveLength(7);
    expect(editor?.permissions).toContain("content:book:create");
    expect(editor?.permissions).not.toContain("content:book:delete");
    expect(board.permissions.map((entry) => entry.code)).toContain(
      "system:role:manage",
    );
    expect(board.roles.map((role) => role.code)).toContain("super_admin");
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
        authUser: {id: "u9", role: null},
        rbacPermissions: new Set(["content:book:read"]),
      },
      request,
    } as never);
    expect(withoutGrant.status).toBe(403);

    const allowed = await getAdminRbacBoard({
      locals: {
        authUser: {id: "u9", role: null},
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
        authUser: {id: "u9", role: null},
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
        authUser: {id: "u9", role: null},
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
