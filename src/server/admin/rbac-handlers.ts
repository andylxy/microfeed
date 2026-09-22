/**
 * RBAC administration handlers (roles <-> permissions).
 *
 * This is the system-domain surface required by the plan §8.1 row
 * "RBAC 管理页（新建） -> system:role:manage / system:permission:manage":
 * reading the board needs `system:role:manage`, changing a role's grants needs
 * `system:permission:manage`.
 */

import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, localizedError} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {permissionId} from "@/server/rbac/seed";
import {RBAC_WILDCARD} from "@/server/rbac/resolve";
import type {RbacBoard, RbacUserBoard} from "@/shared/Rbac";

export type {RbacBoard, RbacBoardRole, RbacUser, RbacUserBoard} from "@/shared/Rbac";

/** Roles, their grants, and the permission catalog the UI assigns from. */
export async function readRbacBoard(db: D1Database): Promise<RbacBoard> {
  const [roles, catalog, grants] = await Promise.all([
    db
      .prepare("SELECT id, code, name FROM ext_roles ORDER BY code")
      .all<{id: string; code: string; name: string}>(),
    db
      .prepare("SELECT code, name FROM ext_permissions ORDER BY code")
      .all<{code: string; name: string}>(),
    db
      .prepare(
        `SELECT rp.role_id AS roleId, p.code AS code
         FROM ext_role_permissions rp
         JOIN ext_permissions p ON p.id = rp.permission_id`,
      )
      .all<{roleId: string; code: string}>(),
  ]);

  const byRole = new Map<string, string[]>();
  for (const grant of grants.results ?? []) {
    const list = byRole.get(grant.roleId) ?? [];
    list.push(grant.code);
    byRole.set(grant.roleId, list);
  }

  return {
    permissions: (catalog.results ?? []).map((row) => ({
      code: row.code,
      name: row.name,
    })),
    roles: (roles.results ?? []).map((row) => ({
      code: row.code,
      name: row.name,
      permissions: (byRole.get(row.id) ?? []).sort(),
    })),
  };
}

export type ReplaceRoleResult =
  | {ok: true}
  | {
      ok: false;
      reason:
        | "unknownRole"
        | "unknownPermission"
        | "wildcardRole"
        | "wildcardPermission";
    };

/**
 * Replace a role's grants wholesale.
 *
 * Two refusals, both about the wildcard:
 * - `super_admin` may not be edited at all: its access comes from `*`, so an
 *   assignment that stripped it would lock every administrator out.
 * - `*` may not be granted to any other role: that would turn the grant into a
 *   second super administrator and make `system:permission:manage` an
 *   escalation path. The dashboard hides the row, but the server has to refuse
 *   too — a crafted request would otherwise bypass the UI.
 */
export async function replaceRolePermissions(
  db: D1Database,
  roleCode: string,
  codes: string[],
): Promise<ReplaceRoleResult> {
  if (roleCode === "super_admin") {
    return {ok: false, reason: "wildcardRole"};
  }
  if (codes.includes(RBAC_WILDCARD)) {
    return {ok: false, reason: "wildcardPermission"};
  }

  const role = await db
    .prepare("SELECT id FROM ext_roles WHERE code = ?")
    .bind(roleCode)
    .first<{id: string}>();
  if (!role) {
    return {ok: false, reason: "unknownRole"};
  }

  const catalog = await db
    .prepare("SELECT code FROM ext_permissions")
    .all<{code: string}>();
  const known = new Set((catalog.results ?? []).map((row) => row.code));
  for (const code of codes) {
    if (!known.has(code)) {
      return {ok: false, reason: "unknownPermission"};
    }
  }

  await db.batch([
    db.prepare("DELETE FROM ext_role_permissions WHERE role_id = ?").bind(role.id),
    ...codes.map((code) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id)
           VALUES (?, ?)`,
        )
        .bind(role.id, permissionId(code)),
    ),
  ]);
  return {ok: true};
}

/** Accounts, the roles granted to them, and the roles available to grant. */
export async function readRbacUsers(db: D1Database): Promise<RbacUserBoard> {
  const [accounts, roles, grants] = await Promise.all([
    db
      .prepare(
        `SELECT id, name, email, role, banned FROM auth_user
         ORDER BY email`,
      )
      .all<{
        banned: number | null;
        email: string;
        id: string;
        name: string;
        role: string | null;
      }>(),
    db
      .prepare("SELECT code, name FROM ext_roles ORDER BY code")
      .all<{code: string; name: string}>(),
    db
      .prepare(
        `SELECT ur.user_id AS userId, r.code AS code
         FROM ext_user_roles ur
         JOIN ext_roles r ON r.id = ur.role_id`,
      )
      .all<{userId: string; code: string}>(),
  ]);

  const byUser = new Map<string, string[]>();
  for (const grant of grants.results ?? []) {
    const list = byUser.get(grant.userId) ?? [];
    list.push(grant.code);
    byUser.set(grant.userId, list);
  }

  return {
    roles: (roles.results ?? []).map((row) => ({
      code: row.code,
      name: row.name,
    })),
    users: (accounts.results ?? []).map((row) => ({
      banned: Number(row.banned) === 1,
      email: row.email,
      id: row.id,
      legacyRole: row.role,
      name: row.name,
      roles: (byUser.get(row.id) ?? []).sort(),
    })),
  };
}

export type ReplaceUserRolesResult =
  | {ok: true}
  | {ok: false; reason: "unknownUser" | "unknownRole" | "lastSuperAdmin"};

const SUPER_ADMIN = "super_admin";

/**
 * Replace the roles granted to one account.
 *
 * Refuses to take `super_admin` away from the last account holding it: that
 * would leave the deployment with nobody able to administer it, and there is no
 * way back in through the dashboard.
 */
export async function replaceUserRoles(
  db: D1Database,
  userId: string,
  roleCodes: string[],
): Promise<ReplaceUserRolesResult> {
  const account = await db
    .prepare("SELECT id FROM auth_user WHERE id = ?")
    .bind(userId)
    .first<{id: string}>();
  if (!account) {
    return {ok: false, reason: "unknownUser"};
  }

  const roles = await db
    .prepare("SELECT id, code FROM ext_roles")
    .all<{id: string; code: string}>();
  const byCode = new Map((roles.results ?? []).map((row) => [row.code, row.id]));
  for (const code of roleCodes) {
    if (!byCode.has(code)) {
      return {ok: false, reason: "unknownRole"};
    }
  }

  const current = await db
    .prepare(
      `SELECT r.code AS code FROM ext_user_roles ur
       JOIN ext_roles r ON r.id = ur.role_id
       WHERE ur.user_id = ?`,
    )
    .bind(userId)
    .all<{code: string}>();
  const currentlySuperAdmin = (current.results ?? []).some(
    (row) => row.code === SUPER_ADMIN,
  );
  if (currentlySuperAdmin && !roleCodes.includes(SUPER_ADMIN)) {
    const holders = await db
      .prepare(
        `SELECT COUNT(*) AS total FROM ext_user_roles ur
         JOIN ext_roles r ON r.id = ur.role_id
         WHERE r.code = ?`,
      )
      .bind(SUPER_ADMIN)
      .first<{total: number}>();
    if ((holders?.total ?? 0) <= 1) {
      return {ok: false, reason: "lastSuperAdmin"};
    }
  }

  await db.batch([
    db.prepare("DELETE FROM ext_user_roles WHERE user_id = ?").bind(userId),
    ...roleCodes.map((code) =>
      db
        .prepare(
          "INSERT OR IGNORE INTO ext_user_roles (user_id, role_id) VALUES (?, ?)",
        )
        .bind(userId, byCode.get(code)),
    ),
  ]);
  return {ok: true};
}

export const getAdminRbacUsers: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    "system:user:manage",
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  return jsonResponse(await readRbacUsers(env.FEED_DB));
};

export const updateAdminRbacUser: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    "system:user:manage",
    request,
    env.FEED_DB,
  );
  if (guard) return guard;

  const body = await request.json().catch(() => null) as
    | {roles?: unknown; userId?: unknown}
    | null;
  if (!body || typeof body.userId !== "string" || !Array.isArray(body.roles)) {
    return localizedError(request, "errors.rbac.invalidUserAssignment", 400);
  }
  const codes = body.roles.filter(
    (code): code is string => typeof code === "string",
  );

  const result = await replaceUserRoles(env.FEED_DB, body.userId, codes);
  if (!result.ok) {
    const status = result.reason === "unknownUser" ? 404 : 400;
    return localizedError(request, `errors.rbac.${result.reason}`, status);
  }
  return jsonResponse(await readRbacUsers(env.FEED_DB));
};

export const getAdminRbacBoard: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    "system:role:manage",
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  return jsonResponse(await readRbacBoard(env.FEED_DB));
};

export const updateAdminRbacRole: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    "system:permission:manage",
    request,
    env.FEED_DB,
  );
  if (guard) return guard;

  const body = await request.json().catch(() => null) as
    | {permissions?: unknown; role?: unknown}
    | null;
  if (!body || typeof body.role !== "string" || !Array.isArray(body.permissions)) {
    return localizedError(request, "errors.rbac.invalidAssignment", 400);
  }
  const codes = body.permissions.filter(
    (code): code is string => typeof code === "string",
  );

  const result = await replaceRolePermissions(env.FEED_DB, body.role, codes);
  if (!result.ok) {
    return localizedError(
      request,
      `errors.rbac.${result.reason}`,
      result.reason === "unknownRole" ? 404 : 400,
    );
  }
  return jsonResponse(await readRbacBoard(env.FEED_DB));
};
