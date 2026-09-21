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
import type {RbacBoard} from "@/shared/Rbac";

export type {RbacBoard, RbacBoardRole} from "@/shared/Rbac";

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
  | {ok: false; reason: "unknownRole" | "unknownPermission" | "wildcardRole"};

/**
 * Replace a role's grants wholesale.
 *
 * `super_admin` is refused on purpose: its access comes from the `*` wildcard,
 * so an assignment that stripped it would lock every administrator out.
 */
export async function replaceRolePermissions(
  db: D1Database,
  roleCode: string,
  codes: string[],
): Promise<ReplaceRoleResult> {
  if (roleCode === "super_admin") {
    return {ok: false, reason: "wildcardRole"};
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
