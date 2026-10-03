/**
 * RBAC administration handlers (roles <-> permissions).
 *
 * This is the system-domain surface required by the plan §8.1 row
 * "RBAC 管理页（新建） -> system:role:manage": reading the board and changing a
 * role's grants are both gated by `system:role:manage`.
 *
 * Grant writes used to require a second code, `system:permission:manage`. It was
 * merged back into `system:role:manage` by migration 0065: the board is one
 * indivisible screen, so a holder of only one of the two codes could reach it
 * but never finish an edit. There is no "grants-only administrator" shape left.
 */

import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, localizedError} from "@/server/http";
import {createMicrofeedAuth} from "@/server/auth/better-auth";
import {
  createLoginCredential,
  LoginCredentialLimitError,
  listLoginCredentialsForUser,
  revokeLoginCredential,
} from "@/server/auth/login-credentials";
import {
  requireAuthenticatedRbac,
  requireRbac,
  type RbacLocals,
} from "@/server/rbac/guard";
import {
  auditStatement,
  type PendingAudit,
  recordRbacAudit,
} from "@/server/rbac/audit";
import {PERMISSION_CODES} from "@/shared/Constants";
import {permissionId, roleId} from "@/server/rbac/seed";
import {RBAC_WILDCARD} from "@/server/rbac/resolve";
import {
  adminAccountKind,
  adminUsernameEmail,
  isReservedAdminEmailDomain,
  MIN_ADMIN_PASSWORD_LENGTH,
  normalizeAdminEmail,
  normalizeAdminUsername,
  validateAdminEmail,
  validateAdminPassword,
  validateAdminUsername,
} from "@/shared/AdminCredentials";
import {
  MAX_LOGIN_CREDENTIALS_PER_USER,
  type LoginCredentialBoard,
} from "@/shared/LoginCredential";
import {
  BETTER_AUTH_ADMIN_ROLE,
  BETTER_AUTH_USER_ROLE,
  buildPermissionTree,
  DEFAULT_USER_ROLE,
  type RbacBoard,
  type RbacUserBoard,
} from "@/shared/Rbac";
import type {AdminDeviceRow} from "@/shared/AppDeviceVersion";

export type {RbacBoard, RbacBoardRole, RbacUser, RbacUserBoard} from "@/shared/Rbac";

/** Roles, their grants, and the permission tree the UI assigns from. */
export async function readRbacBoard(db: D1Database): Promise<RbacBoard> {
  const [roles, catalog, grants, menuRows, mappingRows] = await Promise.all([
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
    db
      .prepare(
        "SELECT code, parent_code, sort FROM ext_menu WHERE is_visible = 1 ORDER BY sort, code",
      )
      .all<{code: string; parent_code: string | null; sort: number}>(),
    db
      .prepare("SELECT menu_code, permission_code FROM ext_menu_permissions")
      .all<{menu_code: string; permission_code: string}>(),
  ]);

  const byRole = new Map<string, string[]>();
  for (const grant of grants.results ?? []) {
    const list = byRole.get(grant.roleId) ?? [];
    list.push(grant.code);
    byRole.set(grant.roleId, list);
  }

  // The tree is organised by the menu: a group is any row another row points at
  // through `parent_code`, and its pages are those children, in `sort` order.
  const pagesByGroup = new Map<string, string[]>();
  for (const row of menuRows.results ?? []) {
    if (!row.parent_code) continue;
    const pages = pagesByGroup.get(row.parent_code) ?? [];
    pages.push(row.code);
    pagesByGroup.set(row.parent_code, pages);
  }
  const menu = (menuRows.results ?? [])
    .filter((row) => pagesByGroup.has(row.code))
    .map((row) => ({code: row.code, pages: pagesByGroup.get(row.code) ?? []}));

  const mapping: Record<string, string[]> = {};
  for (const row of mappingRows.results ?? []) {
    (mapping[row.menu_code] ??= []).push(row.permission_code);
  }

  const permissions = (catalog.results ?? []).map((row) => ({
    code: row.code,
    name: row.name,
  }));

  return {
    groups: buildPermissionTree({mapping, menu, permissions}),
    permissions,
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
 *   second super administrator and make `system:role:manage` an escalation
 *   path. The dashboard hides the row, but the server has to refuse too — a
 *   crafted request would otherwise bypass the UI.
 */
export async function replaceRolePermissions(
  db: D1Database,
  roleCode: string,
  codes: string[],
  audit?: PendingAudit,
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
    // Same batch: the grants and the record of who changed them are atomic.
    ...(audit ? [auditStatement(db, audit)] : []),
  ]);
  return {ok: true};
}

/** Accounts, the roles granted to them, and the roles available to grant. */
export async function readRbacUsers(db: D1Database): Promise<RbacUserBoard> {
  const [accounts, roles, grants] = await Promise.all([
    db
      .prepare(
        `SELECT id, name, email, role, banned, username, displayUsername
         FROM auth_user ORDER BY email`,
      )
      .all<{
        banned: number | null;
        displayUsername: string | null;
        email: string;
        id: string;
        name: string;
        role: string | null;
        username: string | null;
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
      username: row.displayUsername ?? row.username ?? undefined,
    })),
  };
}

/** Devices an account has authenticated from, for the admin device board. */
export async function readRbacUserDevices(
  db: D1Database,
  userId: string,
): Promise<
  Array<{deviceId: string; status: string; lastSeenAt: string | null; createdAt: string | null}>
> {
  const rows = await db
    .prepare(
      `SELECT device_id AS deviceId, status, last_seen_at AS lastSeenAt, created_at AS createdAt
       FROM ext_user_devices WHERE user_id = ? ORDER BY last_seen_at DESC`,
    )
    .bind(userId)
    .all<{deviceId: string; status: string; lastSeenAt: string | null; createdAt: string | null}>();
  return (rows.results ?? []).map((row) => ({
    createdAt: row.createdAt,
    deviceId: row.deviceId,
    lastSeenAt: row.lastSeenAt,
    status: row.status,
  }));
}

export type DeviceMutationResult =
  | {ok: true}
  | {ok: false; reason: "unknownUser" | "unknownDevice"};

/**
 * Every device across every account, for the admin device board (spec §6.1).
 *
 * The board is the "remote device management" control plane: unlike
 * {@link readRbacUserDevices} (one account's own devices), this joins
 * `auth_user` so an operator can see *whose* device a row is. `ext_user_devices`
 * is keyed by `(user_id, device_id)` — revocation is per-account, not global
 * (ADR-0001) — so `userId` must travel with every row.
 *
 * Read-only, and deliberately **unbounded**: spec §1 asks for the full device
 * list, and the board pages it client-side (the same pattern every other admin
 * board uses). `ext_user_devices` grows one row per account-device pair, so the
 * row count tracks real users, not traffic. `status` optionally filters to
 * `active` / `revoked`.
 */
export async function readAllDevices(
  db: D1Database,
  options: {status?: string | null} = {},
): Promise<AdminDeviceRow[]> {
  const clause = options.status ? "WHERE d.status = ?" : "";
  const binds: unknown[] = options.status ? [options.status] : [];
  const rows = await db
    .prepare(
      `SELECT d.device_id AS deviceId, d.user_id AS userId,
              COALESCE(u.displayUsername, u.username) AS username,
              u.email AS email, d.status AS status,
              d.last_seen_at AS lastSeenAt, d.created_at AS createdAt
       FROM ext_user_devices d
       JOIN auth_user u ON u.id = d.user_id
       ${clause}
       ORDER BY d.last_seen_at DESC`,
    )
    .bind(...binds)
    .all<AdminDeviceRow>();
  return rows.results ?? [];
}

/**
 * Revoke one device (Gap E producer, ADR D-010 step 3). The middleware reads
 * `ext_user_devices.status` on every authenticated request, so once a device is
 * `revoked` the guard returns 401 for it — the branch in `requirePermission` is
 * now reachable. Revocation is recoverable via {@link restoreUserDevice}.
 */
export async function revokeUserDevice(
  db: D1Database,
  userId: string,
  deviceId: string,
  audit?: PendingAudit,
): Promise<DeviceMutationResult> {
  const account = await db
    .prepare("SELECT id FROM auth_user WHERE id = ?")
    .bind(userId)
    .first<{id: string}>();
  if (!account) return {ok: false, reason: "unknownUser"};
  const device = await db
    .prepare("SELECT user_id FROM ext_user_devices WHERE user_id = ? AND device_id = ?")
    .bind(userId, deviceId)
    .first<{user_id: string}>();
  if (!device) return {ok: false, reason: "unknownDevice"};
  await db.batch([
    db
      .prepare(
        "UPDATE ext_user_devices SET status = 'revoked' " +
          "WHERE user_id = ? AND device_id = ?",
      )
      .bind(userId, deviceId),
    // Same batch: the revocation and the record of who did it are atomic.
    ...(audit ? [auditStatement(db, audit)] : []),
  ]);
  return {ok: true};
}

/** Restore a previously revoked device back to active (recovery path for Gap E). */
export async function restoreUserDevice(
  db: D1Database,
  userId: string,
  deviceId: string,
  audit?: PendingAudit,
): Promise<DeviceMutationResult> {
  const account = await db
    .prepare("SELECT id FROM auth_user WHERE id = ?")
    .bind(userId)
    .first<{id: string}>();
  if (!account) return {ok: false, reason: "unknownUser"};
  const device = await db
    .prepare("SELECT user_id FROM ext_user_devices WHERE user_id = ? AND device_id = ?")
    .bind(userId, deviceId)
    .first<{user_id: string}>();
  if (!device) return {ok: false, reason: "unknownDevice"};
  await db.batch([
    db
      .prepare(
        "UPDATE ext_user_devices SET status = 'active' " +
          "WHERE user_id = ? AND device_id = ?",
      )
      .bind(userId, deviceId),
    // Same batch: the restoration and the record of who did it are atomic.
    ...(audit ? [auditStatement(db, audit)] : []),
  ]);
  return {ok: true};
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
  audit?: PendingAudit,
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
    // Keep `auth_user.role` a *derived mirror* of the RBAC role: Better Auth's
    // admin plugin gates its own endpoints on that field, so leaving a stale
    // value behind would be a second, invisible way to authorize
    // (see BETTER_AUTH_ADMIN_ROLE).
    db
      .prepare("UPDATE auth_user SET role = ? WHERE id = ?")
      .bind(
        roleCodes.includes(SUPER_ADMIN)
          ? BETTER_AUTH_ADMIN_ROLE
          : BETTER_AUTH_USER_ROLE,
        userId,
      ),
    // The audit row rides the same batch, so the change and its record are
    // atomic: either both land or neither does.
    ...(audit ? [auditStatement(db, audit)] : []),
  ]);
  return {ok: true};
}

export type RoleMutationResult =
  | {ok: true}
  | {
    ok: false;
    reason:
      | "duplicateRole"
      | "unknownRole"
      | "reservedRole"
      | "roleInUse"
      | "invalidRole";
  };

const RESERVED_ROLES = new Set(["super_admin"]);

/**
 * Role codes the code itself depends on *by name*: `super_admin` carries the `*`
 * wildcard, and `readonly` is `DEFAULT_USER_ROLE` — the role a newly created
 * account receives. Both may be relabelled, but their code (the stable identity,
 * mirrored into `ext_roles.id`) must never change and they must not be deleted,
 * or the deployment loses its administrator / its default role.
 */
const CODE_LOCKED_ROLES = new Set(["super_admin", "readonly"]);

/**
 * Create a role. `super_admin` is reserved: it is defined by the seed and
 * carries the `*` wildcard, so a second one would only muddy the decision chain.
 */
export async function createRbacRole(
  db: D1Database,
  code: string,
  name: string,
  audit?: PendingAudit,
): Promise<RoleMutationResult> {
  if (RESERVED_ROLES.has(code)) {
    return {ok: false, reason: "reservedRole"};
  }
  const existing = await db
    .prepare("SELECT id FROM ext_roles WHERE code = ?")
    .bind(code)
    .first<{id: string}>();
  if (existing) {
    return {ok: false, reason: "duplicateRole"};
  }
  await db.batch([
    db
      .prepare("INSERT INTO ext_roles (id, code, name) VALUES (?, ?, ?)")
      .bind(roleId(code), code, name),
    // Same batch: the role and the record of who created it are atomic.
    ...(audit ? [auditStatement(db, audit)] : []),
  ]);
  return {ok: true};
}

/** Rename a role. The code is the stable identity, so only the label changes. */
export async function renameRbacRole(
  db: D1Database,
  code: string,
  name: string,
  audit?: PendingAudit,
): Promise<RoleMutationResult> {
  if (RESERVED_ROLES.has(code)) {
    return {ok: false, reason: "reservedRole"};
  }
  // Existence is checked *before* the write because the audit row rides the same
  // batch — there is no `changes === 0` to inspect afterwards, and a row
  // describing a rename that never happened would be worse than no row.
  const role = await db
    .prepare("SELECT id FROM ext_roles WHERE code = ?")
    .bind(code)
    .first<{id: string}>();
  if (!role) {
    return {ok: false, reason: "unknownRole"};
  }
  await db.batch([
    db.prepare("UPDATE ext_roles SET name = ? WHERE code = ?").bind(name, code),
    // Same batch: the rename and the record of who did it are atomic.
    ...(audit ? [auditStatement(db, audit)] : []),
  ]);
  return {ok: true};
}

/**
 * Change a role's code.
 *
 * `ext_roles.id` is `r_<code>` and both `ext_user_roles.role_id` and
 * `ext_role_permissions.role_id` reference that id with `ON DELETE CASCADE`
 * only — there is no `ON UPDATE CASCADE`, so a bare `UPDATE id` would leave the
 * children pointing at a row that no longer exists. Instead this rebuilds the
 * role under the new id and re-points everything, in one atomic `batch`:
 *
 *   1. copy the role to (id = `r_<new>`, code = new),
 *   2. copy its grants onto the new id,
 *   3. move every account assignment to the new id (`OR REPLACE` guards the
 *      `(user_id, role_id)` primary key should an account hold both),
 *   4. drop the old row; its now-orphaned grants cascade away.
 *
 * `super_admin` / `readonly` are refused ({@link CODE_LOCKED_ROLES}).
 */
export async function renameRbacRoleCode(
  db: D1Database,
  oldCode: string,
  newCode: string,
  audit?: PendingAudit,
): Promise<RoleMutationResult> {
  if (CODE_LOCKED_ROLES.has(oldCode)) {
    return {ok: false, reason: "reservedRole"};
  }
  if (!/^[a-z][a-z0-9_]*$/u.test(newCode)) {
    return {ok: false, reason: "invalidRole"};
  }
  if (newCode === oldCode) {
    return {ok: true};
  }
  const [taken, role] = await Promise.all([
    db.prepare("SELECT id FROM ext_roles WHERE code = ?").bind(newCode)
      .first<{id: string}>(),
    db.prepare("SELECT id FROM ext_roles WHERE code = ?").bind(oldCode)
      .first<{id: string}>(),
  ]);
  if (taken) {
    return {ok: false, reason: "duplicateRole"};
  }
  if (!role) {
    return {ok: false, reason: "unknownRole"};
  }
  const oldId = role.id;
  const newId = roleId(newCode);
  await db.batch([
    db.prepare(
      `INSERT INTO ext_roles (id, code, name, created_at, updated_at)
       SELECT ?, ?, name, created_at, CURRENT_TIMESTAMP FROM ext_roles WHERE id = ?`,
    ).bind(newId, newCode, oldId),
    db.prepare(
      `INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id)
       SELECT ?, permission_id FROM ext_role_permissions WHERE role_id = ?`,
    ).bind(newId, oldId),
    db.prepare(
      "UPDATE OR REPLACE ext_user_roles SET role_id = ? WHERE role_id = ?",
    ).bind(newId, oldId),
    db.prepare("DELETE FROM ext_roles WHERE id = ?").bind(oldId),
    // Same batch: the rebuild and the record of who did it are atomic.
    ...(audit ? [auditStatement(db, audit)] : []),
  ]);
  const moved = await db
    .prepare("SELECT id FROM ext_roles WHERE id = ?")
    .bind(newId)
    .first<{id: string}>();
  if (!moved) {
    return {ok: false, reason: "unknownRole"};
  }
  return {ok: true};
}

/**
 * Delete a role.
 *
 * Refuses when anybody still holds it: removing the row cascades away their
 * grants silently, and the operator should re-assign those accounts first so the
 * effect is deliberate.
 */
export async function deleteRbacRole(
  db: D1Database,
  code: string,
  audit?: PendingAudit,
): Promise<RoleMutationResult> {
  if (CODE_LOCKED_ROLES.has(code)) {
    return {ok: false, reason: "reservedRole"};
  }
  const holders = await db
    .prepare(
      `SELECT COUNT(*) AS total FROM ext_user_roles ur
       JOIN ext_roles r ON r.id = ur.role_id
       WHERE r.code = ?`,
    )
    .bind(code)
    .first<{total: number}>();
  if ((holders?.total ?? 0) > 0) {
    return {ok: false, reason: "roleInUse"};
  }
  // Existence is checked *before* the write because the audit row rides the same
  // batch — there is no `changes === 0` to inspect afterwards, and a row
  // describing a delete that never happened would be worse than no row.
  const role = await db
    .prepare("SELECT id FROM ext_roles WHERE code = ?")
    .bind(code)
    .first<{id: string}>();
  if (!role) {
    return {ok: false, reason: "unknownRole"};
  }
  await db.batch([
    db.prepare("DELETE FROM ext_roles WHERE code = ?").bind(code),
    // Same batch: the deletion and the record of who did it are atomic.
    ...(audit ? [auditStatement(db, audit)] : []),
  ]);
  return {ok: true};
}

export const createAdminRbacRole: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.SYSTEM_ROLE_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;

  const body = await request.json().catch(() => null) as
    | {code?: unknown; name?: unknown}
    | null;
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!code || !name || !/^[a-z][a-z0-9_]*$/u.test(code)) {
    return localizedError(request, "errors.rbac.invalidRole", 400);
  }

  const result = await createRbacRole(env.FEED_DB, code, name, {
    action: "role.create",
    actor: locals.authUser,
    detail: name,
    target: code,
  });
  if (!result.ok) {
    return localizedError(
      request,
      `errors.rbac.${result.reason}`,
      result.reason === "unknownRole" ? 404 : 400,
    );
  }
  return jsonResponse(await readRbacBoard(env.FEED_DB));
};

export const updateAdminRbacRoleName: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.SYSTEM_ROLE_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;

  const body = await request.json().catch(() => null) as
    {code?: unknown; name?: unknown} | null;
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!code || !name) {
    return localizedError(request, "errors.rbac.invalidRole", 400);
  }

  const result = await renameRbacRole(env.FEED_DB, code, name, {
    action: "role.rename",
    actor: locals.authUser,
    detail: name,
    target: code,
  });
  if (!result.ok) {
    return localizedError(
      request,
      `errors.rbac.${result.reason}`,
      result.reason === "unknownRole" ? 404 : 400,
    );
  }
  return jsonResponse(await readRbacBoard(env.FEED_DB));
};

/**
 * Change a role's code (cascading rebuild — see {@link renameRbacRoleCode}).
 * Gated like the other role mutations (`system:role:manage`).
 */
export const updateAdminRbacRoleCode: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.SYSTEM_ROLE_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;

  const body = await request.json().catch(() => null) as
    {code?: unknown; newCode?: unknown} | null;
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  const newCode = typeof body?.newCode === "string" ? body.newCode.trim() : "";
  if (!code || !newCode) {
    return localizedError(request, "errors.rbac.invalidRole", 400);
  }

  const result = await renameRbacRoleCode(env.FEED_DB, code, newCode, {
    action: "role.renameCode",
    actor: locals.authUser,
    detail: newCode,
    target: code,
  });
  if (!result.ok) {
    const status = result.reason === "unknownRole"
      ? 404
      : result.reason === "duplicateRole"
        ? 409
        : 400;
    return localizedError(request, `errors.rbac.${result.reason}`, status);
  }
  return jsonResponse(await readRbacBoard(env.FEED_DB));
};

export const deleteAdminRbacRole: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.SYSTEM_ROLE_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;

  const body = await request.json().catch(() => null) as {code?: unknown} | null;
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!code) {
    return localizedError(request, "errors.rbac.invalidRole", 400);
  }

  const result = await deleteRbacRole(env.FEED_DB, code, {
    action: "role.delete",
    actor: locals.authUser,
    target: code,
  });
  if (!result.ok) {
    return localizedError(
      request,
      `errors.rbac.${result.reason}`,
      result.reason === "unknownRole" ? 404 : 409,
    );
  }
  return jsonResponse(await readRbacBoard(env.FEED_DB));
};

/**
 * Account lifecycle, delegated to Better Auth's admin plugin.
 *
 * Creating and removing accounts is deliberately not done with SQL here: the
 * plugin owns `auth_user` (and the credential rows), so going through it keeps
 * password hashing and session cleanup on the supported path. RBAC only supplies
 * the `system:user:manage` gate and the role assignment on top.
 */
export const createAdminRbacUser: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.SYSTEM_USER_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;

  const body = await request.json().catch(() => null) as
    | {
      account?: unknown;
      email?: unknown;
      name?: unknown;
      password?: unknown;
      roles?: unknown;
      username?: unknown;
    }
    | null;
  // The form sends the username and the address as two separate fields, each
  // landing in the column it belongs to: the username is the identity and is
  // required, the address is optional and becomes a synthesised placeholder
  // when it is left out. A `username` in the body is what marks the new form;
  // without one this stays on the legacy path, where `email` (or `account`)
  // alone still creates an address-only account for an older dashboard build.
  const typedUsername = typeof body?.username === "string"
    ? body.username.trim()
    : "";
  const typedEmail = typeof body?.email === "string" ? body.email.trim() : "";
  const legacyAccount = typeof body?.account === "string"
    ? body.account.trim()
    : "";
  const account = typedUsername || typedEmail || legacyAccount;
  const splitFields = Boolean(typedUsername);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  // Roles come from the create form; when none are sent the account still gets
  // the read-only default rather than being created permission-less.
  const requestedRoles = Array.isArray(body?.roles)
    ? body.roles.filter((role): role is string => typeof role === "string")
    : [];
  const roleCodes = requestedRoles.length > 0
    ? requestedRoles
    : [DEFAULT_USER_ROLE];
  if (!account || !name) {
    return localizedError(request, "errors.rbac.invalidNewUser", 400);
  }
  if (validateAdminPassword(password)) {
    return localizedError(request, "errors.password.policy", 400, {
      min: String(MIN_ADMIN_PASSWORD_LENGTH),
    });
  }

  const accountKind = adminAccountKind(account);
  const username = splitFields || accountKind === "username"
    ? normalizeAdminUsername(splitFields ? typedUsername : account)
    : null;
  let email: string;
  if (splitFields) {
    if (validateAdminUsername(typedUsername)) {
      return localizedError(request, "errors.rbac.invalidUsername", 400);
    }
    if (typedEmail) {
      if (validateAdminEmail(typedEmail)) {
        return localizedError(request, "errors.rbac.invalidEmail", 400);
      }
      // The placeholder domain belongs to the synthesised addresses, so an
      // operator claiming one would silently take an existing account's slot.
      if (isReservedAdminEmailDomain(typedEmail)) {
        return localizedError(request, "errors.rbac.reservedEmailDomain", 400);
      }
    }
    email = typedEmail
      ? normalizeAdminEmail(typedEmail)
      : adminUsernameEmail(typedUsername);
  } else if (accountKind === "email") {
    if (validateAdminEmail(account)) {
      return localizedError(request, "errors.rbac.invalidEmail", 400);
    }
    if (isReservedAdminEmailDomain(account)) {
      return localizedError(request, "errors.rbac.reservedEmailDomain", 400);
    }
    email = normalizeAdminEmail(account);
  } else {
    if (validateAdminUsername(account)) {
      return localizedError(request, "errors.rbac.invalidUsername", 400);
    }
    // better-auth requires an address on every user, so a username-only account
    // gets a placeholder under a domain that never resolves; the username is
    // what signs it in (see AdminCredentials.ts).
    email = adminUsernameEmail(account);
  }

  // Uniqueness, checked once for every path: the username and the address are
  // the two things an account signs in with, so a clash has to be reported as
  // one instead of falling through to the write and surfacing as a generic
  // failure. Both comparisons are case-insensitive — usernames are stored
  // lowercased and addresses normalised, so "Bob" and "bob" are the same
  // account. The address check also covers the placeholder addresses that
  // username-only accounts hold.
  if (username && await usernameIsTaken(env.FEED_DB, username)) {
    return localizedError(request, "errors.rbac.usernameTaken", 409);
  }
  if (await emailIsTaken(env.FEED_DB, email)) {
    return localizedError(request, "errors.rbac.emailTaken", 409);
  }

  // Validate the role codes before the account exists: a bad code must not
  // leave an orphan account that no error message can explain.
  const knownRoles = await env.FEED_DB.prepare("SELECT code FROM ext_roles")
    .all<{code: string}>();
  const knownRoleCodes = new Set(
    (knownRoles.results ?? []).map((row) => row.code),
  );
  const unknownRole = roleCodes.find((code) => !knownRoleCodes.has(code));
  if (unknownRole) {
    return localizedError(request, "errors.rbac.unknownRole", 404);
  }

  let newUserId: string | null = null;
  try {
    const created = await createMicrofeedAuth(env, request).api.createUser({
      body: {
        email,
        name,
        password,
        role: "user",
        // Extra user fields ride through `data`; the username plugin's
        // `user.create.before` hook re-validates and normalizes them, so this is
        // the same gate the username sign-in endpoint reads back.
        ...(username
          ? {data: {displayUsername: account, username}}
          : {}),
      },
      headers: request.headers,
    });
    newUserId = (created as {user?: {id?: string}} | undefined)?.user?.id ?? null;
  } catch {
    return localizedError(request, "errors.rbac.createUserFailed", 400);
  }

  // Better Auth's createUser may not echo the id; fall back to a lookup so the
  // role rows below always land on the right account.
  if (!newUserId) {
    const row = await env.FEED_DB.prepare(
      "SELECT id FROM auth_user WHERE lower(email) = lower(?)",
    ).bind(email).first<{id: string}>();
    newUserId = row?.id ?? null;
  }
  const createAudit: PendingAudit = {
    action: "user.create",
    actor: locals.authUser,
    detail: roleCodes.join(","),
    target: newUserId ?? email,
  };
  if (newUserId) {
    // Local policy — this deployment does not force a password change on first
    // sign-in (see the upstream-divergence note in .workbuddy memory; migration
    // 0042 clears the flag for accounts created under the old behaviour). The
    // account starts with the roles the operator ticked, defaulting to
    // `readonly`, so a fresh account is never permission-less.
    // The role assignments and the record of who created the account ride the
    // same batch, so the change and its trail are atomic. The Better Auth account
    // creation above is the one part we cannot batch with — it is a separate,
    // idempotent write elsewhere.
    await env.FEED_DB.batch([
      env.FEED_DB.prepare("DELETE FROM ext_user_roles WHERE user_id = ?")
        .bind(newUserId),
      ...roleCodes.map((code) =>
        env.FEED_DB.prepare(
          "INSERT OR IGNORE INTO ext_user_roles (user_id, role_id) VALUES (?, ?)",
        ).bind(newUserId, roleId(code)),
      ),
      // B1: mirror the chosen RBAC role onto `auth_user.role` so Better Auth's
      // admin plugin gates its own endpoints on the same source of truth. Without
      // this, a freshly created super-admin keeps `role = "user"` and a second,
      // invisible authorization path splits from RBAC. Shape mirrors
      // `replaceUserRoles` so the two code paths cannot drift apart.
      env.FEED_DB.prepare("UPDATE auth_user SET role = ? WHERE id = ?")
        .bind(
          roleCodes.includes(SUPER_ADMIN)
            ? BETTER_AUTH_ADMIN_ROLE
            : BETTER_AUTH_USER_ROLE,
          newUserId,
        ),
      auditStatement(env.FEED_DB, createAudit),
    ]);
  } else {
    // No user id was ever resolved, so the row can't be tied to the account —
    // write it on its own; the account creation itself is the Better Auth part we
    // can't batch with.
    await recordRbacAudit(createAudit);
  }
  return jsonResponse(await readRbacUsers(env.FEED_DB));
};

export const deleteAdminRbacUser: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.SYSTEM_USER_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;

  const body = await request.json().catch(() => null) as {userId?: unknown} | null;
  const userId = parseRbacUserId(body);
  if (!userId) {
    return localizedError(request, "errors.rbac.invalidUserAssignment", 400);
  }
  // The last super_admin holder cannot delete themselves: the guard on
  // `replaceUserRoles` covers dropping the role, this covers removing the account
  // that carries it.
  const board = await readRbacUsers(env.FEED_DB);
  const target = board.users.find((entry) => entry.id === userId);
  if (!target) {
    return localizedError(request, "errors.rbac.unknownUser", 404);
  }
  if (target.roles.includes(SUPER_ADMIN)) {
    const holders = board.users.filter((entry) =>
      entry.roles.includes(SUPER_ADMIN),
    ).length;
    if (holders <= 1) {
      return localizedError(request, "errors.rbac.lastSuperAdmin", 400);
    }
  }

  try {
    await createMicrofeedAuth(env, request).api.removeUser({
      body: {userId},
      headers: request.headers,
    });
  } catch {
    return localizedError(request, "errors.rbac.deleteUserFailed", 400);
  }
  // B16: login credentials carry no ON DELETE CASCADE (migrations/0036 leaves
  // cleanup to application code), so removing the account here would otherwise
  // orphan its mflc_ tokens. The account is gone, so drop its credentials too.
  await env.FEED_DB.prepare(
    "DELETE FROM ext_login_credentials WHERE user_id = ?",
  ).bind(userId).run();
  // The account removal goes through Better Auth's admin plugin, so it cannot
  // share a batch with our trail — written on its own. The removal itself is
  // idempotent: a retry after a failed audit write does not un-delete anything.
  await recordRbacAudit({
    action: "user.delete",
    actor: locals.authUser,
    target: userId,
  });
  return jsonResponse(await readRbacUsers(env.FEED_DB));
};

export const updateAdminRbacUserBan: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.SYSTEM_USER_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;

  const body = await request.json().catch(() => null) as
    | {banned?: unknown; userId?: unknown}
    | null;
  const userId = parseRbacUserId(body);
  if (!userId || typeof body?.banned !== "boolean") {
    return localizedError(request, "errors.rbac.invalidUserAssignment", 400);
  }
  // Refusing to ban the last super_admin keeps the deployment reachable: the
  // gate would 401 them on every guarded endpoint with no way back in.
  if (body.banned) {
    const board = await readRbacUsers(env.FEED_DB);
    const target = board.users.find((entry) => entry.id === userId);
    if (target?.roles.includes(SUPER_ADMIN)) {
      const holders = board.users.filter((entry) =>
        entry.roles.includes(SUPER_ADMIN) && !entry.banned,
      ).length;
      if (holders <= 1) {
        return localizedError(request, "errors.rbac.lastSuperAdmin", 400);
      }
    }
  }

  try {
    const auth = createMicrofeedAuth(env, request);
    await (body.banned ? auth.api.banUser : auth.api.unbanUser)({
      body: {userId},
      headers: request.headers,
    });
  } catch {
    return localizedError(request, "errors.rbac.banUserFailed", 400);
  }
  // The ban/unban goes through Better Auth's admin plugin, so it cannot share a
  // batch with our trail — written on its own. The toggle is idempotent: retries
  // are harmless.
  await recordRbacAudit({
    action: body.banned ? "user.ban" : "user.unban",
    actor: locals.authUser,
    target: userId,
  });
  return jsonResponse(await readRbacUsers(env.FEED_DB));
};

/** Pull a trimmed `userId` string out of an RBAC action body, or "" if absent. */
function parseRbacUserId(body: {userId?: unknown} | null): string {
  return typeof body?.userId === "string" ? body.userId.trim() : "";
}

/**
 * Whether a username is already taken.
 *
 * Compared case-insensitively: the username plugin stores the lowercased form,
 * so "Bob" and "bob" name one account, and SQLite's UNIQUE index compares bytes
 * rather than letters, so it would happily admit the second spelling. Every
 * pre-write check goes through here so the rule cannot drift between callers.
 */
async function usernameIsTaken(
  database: D1Database,
  username: string,
): Promise<boolean> {
  const row = await database.prepare(
    "SELECT id FROM auth_user WHERE lower(username) = lower(?)",
  ).bind(username).first<{id: string}>();
  return Boolean(row);
}

/**
 * Whether an address is already used by an account, optionally ignoring one
 * account (`exceptUserId`) so an edit is not compared against itself.
 *
 * Case-insensitive for the same reason as the username: SQLite's UNIQUE index
 * is byte-wise, so `Bob@example.com` and `bob@example.com` are two rows unless
 * this check stops them.
 */
async function emailIsTaken(
  database: D1Database,
  email: string,
  exceptUserId?: string,
): Promise<boolean> {
  const statement = exceptUserId
    ? database.prepare(
      "SELECT id FROM auth_user WHERE lower(email) = lower(?) AND id <> ?",
    ).bind(email, exceptUserId)
    : database.prepare(
      "SELECT id FROM auth_user WHERE lower(email) = lower(?)",
    ).bind(email);
  const row = await statement.first<{id: string}>();
  return Boolean(row);
}

/**
 * Map a Better Auth admin-plugin error to our localized response. A 404
 * (`NOT_FOUND`) means the target user does not exist; any other client error is
 * surfaced through `failedKey`; everything else is a 500.
 */
function mapBetterAuthError(
  request: Request,
  error: unknown,
  failedKey: string,
): Response {
  const statusCode = (error as {statusCode?: unknown})?.statusCode;
  const statusText = (error as {status?: unknown})?.status;
  if (statusCode === 404 || statusText === "NOT_FOUND") {
    return localizedError(request, "errors.rbac.unknownUser", 404);
  }
  if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
    return localizedError(request, failedKey, 400);
  }
  console.error(failedKey, error);
  return localizedError(request, failedKey, 500);
}

/**
 * Revoke every credential derived from an account after a forced password
 * reset: dashboard sessions, OAuth app grants (access/refresh tokens, consents,
 * connections), and the `mflc_` login credentials. This closes at least the
 * same surface as the CLI `reset-password` path (`manage-cli/lib/auth.ts`
 * `passwordResetSql` — sessions plus the OAuth tables) and goes one step
 * further by also revoking the login credentials — leaving a reset account's
 * third-party app access or API keys alive would defeat the point of a reset
 * done in response to a suspected compromise. The user's own
 * `auth_user`/`auth_account` rows are left intact; only the *derived* grants go.
 *
 * `keepSessionId` spares one dashboard session — used when the admin resets
 * their own account so the reset does not sign them out of the request that
 * performs it.
 */
async function revokeUserDerivedCredentials(
  database: D1Database,
  userId: string,
  keepSessionId?: string,
): Promise<void> {
  const sessionDelete = keepSessionId
    ? database.prepare('DELETE FROM "auth_session" WHERE "userId" = ? AND "id" <> ?')
      .bind(userId, keepSessionId)
    : database.prepare('DELETE FROM "auth_session" WHERE "userId" = ?').bind(userId);
  await database.batch([
    sessionDelete,
    database.prepare('DELETE FROM "oauth_access_token" WHERE "userId" = ?').bind(userId),
    database.prepare('DELETE FROM "oauth_refresh_token" WHERE "userId" = ?').bind(userId),
    database.prepare('DELETE FROM "oauth_consent" WHERE "userId" = ?').bind(userId),
    database.prepare('DELETE FROM "oauth_connection" WHERE "userId" = ?').bind(userId),
    database.prepare('DELETE FROM "ext_login_credentials" WHERE "user_id" = ?').bind(userId),
  ]);
}

/**
 * Admin-set password reset.
 *
 * The operator types a new password; Better Auth's `set-user-password` writes
 * it (re-hashing). That admin endpoint does NOT revoke the target's existing
 * sessions, OAuth app grants, or login credentials — the
 * `revokeSessionsOnPasswordReset` hook only fires on the user-facing
 * reset/change flows, not the admin one — so we pull every derived credential via
 * `revokeUserDerivedCredentials` to make "admin reset = signed out and
 * de-authorized everywhere" true. That closes at least the surface the CLI
 * `reset-password` flow closes, and additionally revokes the `mflc_` login
 * credentials. When the admin resets their *own* account, the current session
 * is preserved so the reset does not sign them out of the request performing
 * it; every other derived credential is still revoked. The
 * combination policy is ours (`validateAdminPassword`), because Better Auth
 * only checks length, so it is enforced here rather than at the client alone.
 * No email is involved, so username-only accounts (whose address is a
 * non-routing placeholder) can still be reset.
 */
export const resetAdminRbacUserPassword: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.SYSTEM_USER_MANAGE,
    request, env.FEED_DB);
  if (guard) return guard;

  const body = await request.json().catch(() => null) as
    | {newPassword?: unknown; userId?: unknown}
    | null;
  const userId = parseRbacUserId(body);
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
  if (!userId) {
    return localizedError(request, "errors.rbac.invalidUserAssignment", 400);
  }
  if (validateAdminPassword(newPassword)) {
    return localizedError(request, "errors.password.policy", 400, {
      min: String(MIN_ADMIN_PASSWORD_LENGTH),
    });
  }
  try {
    await createMicrofeedAuth(env, request).api.setUserPassword({
      body: {newPassword, userId},
      headers: request.headers,
    });
  } catch (error) {
    return mapBetterAuthError(request, error, "errors.rbac.passwordResetFailed");
  }
  // The admin `set-user-password` endpoint only re-hashes the password; it does
  // not revoke the target's sessions, OAuth grants, or login credentials, so we
  // pull every derived credential to make the reset effective everywhere. A
  // self-reset keeps the performing session alive (otherwise the admin would be
  // signed out mid-request); resetting anyone else loses every session. If the
  // current session cannot be identified, everything is revoked (fail closed).
  await revokeUserDerivedCredentials(
    env.FEED_DB,
    userId,
    locals.authUser?.id === userId ? locals.authSession?.id : undefined,
  );
  await recordRbacAudit({
    action: "user.passwordReset",
    actor: locals.authUser,
    target: userId,
  });
  return jsonResponse(await readRbacUsers(env.FEED_DB));
};

/**
 * Admin edit of an account's display name, email, and/or username.
 *
 * All three go through Better Auth's `admin-update-user` (`data`), which the
 * admin role may call (`user: ["update"]`, and `user: ["set-email"]` for the
 * email). Email uniqueness is checked here first so the precise `emailTaken`
 * (409) can be returned instead of letting the write throw; Better Auth
 * lowercases the address the same way `normalizeAdminEmail` does. The username
 * is a one-way door: an account created before the username column existed may
 * be given one, but an existing username is never overwritten, because it is
 * what sign-in resolves. Only `name`/`email`/`username` change — no forced
 * password reset, matching the local "no first-sign-in reset" policy.
 */
export const updateAdminRbacUserProfile: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.SYSTEM_USER_MANAGE,
    request, env.FEED_DB);
  if (guard) return guard;

  const body = await request.json().catch(() => null) as
    | {email?: unknown; name?: unknown; userId?: unknown; username?: unknown}
    | null;
  const userId = parseRbacUserId(body);
  if (!userId) {
    return localizedError(request, "errors.rbac.invalidUserAssignment", 400);
  }
  const rawEmail = typeof body?.email === "string" ? body.email.trim() : undefined;
  const rawName = typeof body?.name === "string" ? body.name.trim() : undefined;
  const rawUsername = typeof body?.username === "string"
    ? body.username.trim()
    : undefined;
  if (rawEmail === undefined && rawName === undefined && rawUsername === undefined) {
    return localizedError(request, "errors.rbac.invalidUserAssignment", 400);
  }
  const data: Record<string, string> = {};
  if (rawUsername !== undefined) {
    // Only the accounts that predate the username column may be given one: an
    // existing username is the identifier sessions and tokens resolve against,
    // so it is set once and then locked rather than being silently swapped.
    const current = await env.FEED_DB.prepare(
      "SELECT username FROM auth_user WHERE id = ?",
    ).bind(userId).first<{username: string | null}>();
    if (!current) {
      return localizedError(request, "errors.rbac.unknownUser", 404);
    }
    if (current.username) {
      return localizedError(request, "errors.rbac.usernameLocked", 400);
    }
    if (validateAdminUsername(rawUsername)) {
      return localizedError(request, "errors.rbac.invalidUsername", 400);
    }
    const username = normalizeAdminUsername(rawUsername);
    if (await usernameIsTaken(env.FEED_DB, username)) {
      return localizedError(request, "errors.rbac.usernameTaken", 409);
    }
    data.username = username;
    data.displayUsername = rawUsername;
  }
  if (rawName !== undefined) {
    if (!rawName) {
      return localizedError(request, "errors.rbac.invalidName", 400);
    }
    data.name = rawName;
  }
  if (rawEmail !== undefined) {
    const email = normalizeAdminEmail(rawEmail);
    if (validateAdminEmail(email)) {
      return localizedError(request, "errors.rbac.invalidEmail", 400);
    }
    // The placeholder domain is reserved for username-only accounts, so no
    // operator should be able to point a real address at it.
    if (isReservedAdminEmailDomain(email)) {
      return localizedError(request, "errors.rbac.reservedEmailDomain", 400);
    }
    // Compared case-insensitively and against every account but this one, so a
    // mixed-case row cannot slip past the 409 and surface as a generic failure
    // inside `adminUpdateUser`.
    if (await emailIsTaken(env.FEED_DB, email, userId)) {
      return localizedError(request, "errors.rbac.emailTaken", 409);
    }
    data.email = email;
  }
  try {
    await createMicrofeedAuth(env, request).api.adminUpdateUser({
      body: {userId, data},
      headers: request.headers,
    });
  } catch (error) {
    return mapBetterAuthError(request, error, "errors.rbac.profileUpdateFailed");
  }
  await recordRbacAudit({
    action: "user.profile",
    actor: locals.authUser,
    detail: Object.keys(data).join(","),
    target: userId,
  });
  return jsonResponse(await readRbacUsers(env.FEED_DB));
};

export const getAdminRbacUsers: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.SYSTEM_USER_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  return jsonResponse(await readRbacUsers(env.FEED_DB));
};

export const updateAdminRbacUser: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.SYSTEM_USER_MANAGE,
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

  const previous = await env.FEED_DB.prepare(
    "SELECT r.code AS code FROM ext_user_roles ur " +
      "JOIN ext_roles r ON r.id = ur.role_id " +
      "WHERE ur.user_id = ? ORDER BY r.code",
  ).bind(body.userId).all<{code: string}>();

  const result = await replaceUserRoles(env.FEED_DB, body.userId, codes, {
    action: "user.roles",
    actor: locals.authUser,
    before: (previous.results ?? []).map((row) => row.code).join(","),
    detail: codes.join(","),
    target: body.userId,
  });
  if (!result.ok) {
    const status = result.reason === "unknownUser" ? 404 : 400;
    return localizedError(request, `errors.rbac.${result.reason}`, status);
  }
  return jsonResponse(await readRbacUsers(env.FEED_DB));
};

export const updateAdminRbacRole: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.SYSTEM_ROLE_MANAGE,
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

  // Read the current grants first: an audit row is only useful if it says what
  // the value changed *from*, not just what it changed to.
  const previous = await env.FEED_DB.prepare(
    "SELECT p.code AS code FROM ext_role_permissions rp " +
      "JOIN ext_roles r ON r.id = rp.role_id " +
      "JOIN ext_permissions p ON p.id = rp.permission_id " +
      "WHERE r.code = ? ORDER BY p.code",
  ).bind(body.role).all<{code: string}>();

  const result = await replaceRolePermissions(env.FEED_DB, body.role, codes, {
    action: "role.permissions",
    actor: locals.authUser,
    before: (previous.results ?? []).map((row) => row.code).join(","),
    detail: codes.join(","),
    target: body.role,
  });
  if (!result.ok) {
    return localizedError(
      request,
      `errors.rbac.${result.reason}`,
      result.reason === "unknownRole" ? 404 : 400,
    );
  }
  return jsonResponse(await readRbacBoard(env.FEED_DB));
};

/** List the devices an account has authenticated from (device board). */
export const getAdminRbacUserDevices: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.SYSTEM_USER_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const userId = new URL(request.url).searchParams.get("userId") ?? "";
  if (!userId) {
    return localizedError(request, "errors.rbac.invalidUserAssignment", 400);
  }
  return jsonResponse(await readRbacUserDevices(env.FEED_DB, userId));
};

/** Revoke a single device so the guard 401s every request from it (Gap E). */
export const updateAdminRbacUserDeviceRevoke: APIRoute = async ({
  locals,
  request,
}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.SYSTEM_USER_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const body = await request.json().catch(() => null) as
    | {deviceId?: unknown; userId?: unknown}
    | null;
  const userId = parseRbacUserId(body);
  const deviceId = typeof body?.deviceId === "string" ? body.deviceId.trim() : "";
  if (!userId || !deviceId) {
    return localizedError(request, "errors.rbac.invalidUserAssignment", 400);
  }
  const result = await revokeUserDevice(env.FEED_DB, userId, deviceId, {
    action: "device.revoke",
    actor: locals.authUser,
    detail: deviceId,
    target: userId,
  });
  if (!result.ok) {
    return localizedError(
      request,
      `errors.rbac.${result.reason}`,
      result.reason === "unknownUser" || result.reason === "unknownDevice"
        ? 404
        : 400,
    );
  }
  return jsonResponse(await readRbacUserDevices(env.FEED_DB, userId));
};

/** Restore a previously revoked device back to active (recovery for Gap E). */
export const updateAdminRbacUserDeviceRestore: APIRoute = async ({
  locals,
  request,
}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.SYSTEM_USER_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const body = await request.json().catch(() => null) as
    | {deviceId?: unknown; userId?: unknown}
    | null;
  const userId = parseRbacUserId(body);
  const deviceId = typeof body?.deviceId === "string" ? body.deviceId.trim() : "";
  if (!userId || !deviceId) {
    return localizedError(request, "errors.rbac.invalidUserAssignment", 400);
  }
  const result = await restoreUserDevice(env.FEED_DB, userId, deviceId, {
    action: "device.restore",
    actor: locals.authUser,
    detail: deviceId,
    target: userId,
  });
  if (!result.ok) {
    return localizedError(
      request,
      `errors.rbac.${result.reason}`,
      result.reason === "unknownUser" || result.reason === "unknownDevice"
        ? 404
        : 400,
    );
  }
  return jsonResponse(await readRbacUserDevices(env.FEED_DB, userId));
};

// ---------------------------------------------------------------------------
// Login credentials. These endpoints are dual-audience on purpose: the account
// page manages the caller's *own* credentials (no grant needed), while the user
// management page manages another account's and therefore needs
// `system:user:manage`. Omitting `userId` means "me".
// ---------------------------------------------------------------------------

/**
 * Allow a caller to manage `targetUserId`'s login credentials when it is their
 * own account, or when they hold `system:user:manage`.
 */
async function authorizeLoginCredentialAccess(
  locals: RbacLocals,
  request: Request,
  targetUserId: string,
): Promise<Response | null> {
  const callerId = locals.authUser?.id;
  if (callerId && callerId === targetUserId) {
    return requireAuthenticatedRbac(locals, request, env.FEED_DB);
  }
  return requireRbac(locals, PERMISSION_CODES.SYSTEM_USER_MANAGE, request, env.FEED_DB);
}

/** The credentials a user may present to sign in, with their plaintext tokens. */
export async function readRbacUserLoginCredentials(
  db: D1Database,
  userId: string,
): Promise<LoginCredentialBoard> {
  return {credentials: await listLoginCredentialsForUser(db, userId), userId};
}

/** GET `?userId=` — list login credentials; omit `userId` to list your own. */
export const getAdminRbacUserCredentials: APIRoute = async ({
  locals,
  request,
  url,
}) => {
  const targetUserId = url.searchParams.get("userId")?.trim() ||
    locals.authUser?.id ||
    "";
  if (!targetUserId) {
    return localizedError(request, "errors.rbac.unknownUser", 404);
  }
  const guard = await authorizeLoginCredentialAccess(
    locals,
    request,
    targetUserId,
  );
  if (guard) return guard;
  return jsonResponse(
    await readRbacUserLoginCredentials(env.FEED_DB, targetUserId),
  );
};

/** POST `{userId?, name, expiresAtMs?}` — issue a credential (token returned). */
export const createAdminRbacUserCredential: APIRoute = async ({
  locals,
  request,
}) => {
  const body = await request.json().catch(() => null) as
    | {expiresAtMs?: unknown; name?: unknown; userId?: unknown}
    | null;
  const targetUserId = (typeof body?.userId === "string"
    ? body.userId.trim()
    : "") || locals.authUser?.id || "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!targetUserId) {
    return localizedError(request, "errors.rbac.unknownUser", 404);
  }
  if (!name) {
    return localizedError(request, "errors.loginCredential.invalidName", 400);
  }
  const guard = await authorizeLoginCredentialAccess(
    locals,
    request,
    targetUserId,
  );
  if (guard) return guard;

  const account = await env.FEED_DB
    .prepare("SELECT id FROM auth_user WHERE id = ?")
    .bind(targetUserId)
    .first<{id: string}>();
  if (!account) {
    return localizedError(request, "errors.rbac.unknownUser", 404);
  }

  const expiresAtMs = typeof body?.expiresAtMs === "number" &&
      Number.isFinite(body.expiresAtMs)
    ? body.expiresAtMs
    : null;
  try {
    await createLoginCredential(env.FEED_DB, {
      expiresAtMs,
      name,
      userId: targetUserId,
    }, {
      action: "credential.create",
      actor: locals.authUser,
      detail: name,
      target: targetUserId,
    });
  } catch (error) {
    if (error instanceof LoginCredentialLimitError) {
      return localizedError(request, "errors.loginCredential.limitReached", 409, {
        count: String(MAX_LOGIN_CREDENTIALS_PER_USER),
      });
    }
    if (error instanceof TypeError) {
      return localizedError(request, "errors.loginCredential.invalidName", 400);
    }
    throw error;
  }
  return jsonResponse(
    await readRbacUserLoginCredentials(env.FEED_DB, targetUserId),
    {status: 201},
  );
};

/** POST `{userId?, credentialId}` — revoke one credential. */
export const revokeAdminRbacUserCredential: APIRoute = async ({
  locals,
  request,
}) => {
  const body = await request.json().catch(() => null) as
    | {credentialId?: unknown; userId?: unknown}
    | null;
  const targetUserId = (typeof body?.userId === "string"
    ? body.userId.trim()
    : "") || locals.authUser?.id || "";
  const credentialId = typeof body?.credentialId === "string"
    ? body.credentialId.trim()
    : "";
  if (!targetUserId) {
    return localizedError(request, "errors.rbac.unknownUser", 404);
  }
  if (!credentialId) {
    return localizedError(request, "errors.loginCredential.unknown", 404);
  }
  const guard = await authorizeLoginCredentialAccess(
    locals,
    request,
    targetUserId,
  );
  if (guard) return guard;

  const revoked = await revokeLoginCredential(
    env.FEED_DB,
    targetUserId,
    credentialId,
    {
      action: "credential.revoke",
      actor: locals.authUser,
      target: targetUserId,
    },
  );
  if (!revoked) {
    return localizedError(request, "errors.loginCredential.unknown", 404);
  }
  return jsonResponse(
    await readRbacUserLoginCredentials(env.FEED_DB, targetUserId),
  );
};
