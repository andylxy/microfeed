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
import {PERMISSION_CODES} from "@/shared/Constants";
import {permissionId, roleId} from "@/server/rbac/seed";
import {RBAC_WILDCARD} from "@/server/rbac/resolve";
import {
  adminAccountKind,
  adminUsernameEmail,
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
 * Revoke one device (Gap E producer, ADR D-010 step 3). The middleware reads
 * `ext_user_devices.status` on every authenticated request, so once a device is
 * `revoked` the guard returns 401 for it — the branch in `requirePermission` is
 * now reachable. Revocation is recoverable via {@link restoreUserDevice}.
 */
export async function revokeUserDevice(
  db: D1Database,
  userId: string,
  deviceId: string,
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
  await db
    .prepare("UPDATE ext_user_devices SET status = 'revoked' WHERE user_id = ? AND device_id = ?")
    .bind(userId, deviceId)
    .run();
  return {ok: true};
}

/** Restore a previously revoked device back to active (recovery path for Gap E). */
export async function restoreUserDevice(
  db: D1Database,
  userId: string,
  deviceId: string,
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
  await db
    .prepare("UPDATE ext_user_devices SET status = 'active' WHERE user_id = ? AND device_id = ?")
    .bind(userId, deviceId)
    .run();
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

export type RoleMutationResult =
  | {ok: true}
  | {ok: false; reason: "duplicateRole" | "unknownRole" | "reservedRole" | "roleInUse"};

const RESERVED_ROLES = new Set(["super_admin"]);

/**
 * Create a role. `super_admin` is reserved: it is defined by the seed and
 * carries the `*` wildcard, so a second one would only muddy the decision chain.
 */
export async function createRbacRole(
  db: D1Database,
  code: string,
  name: string,
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
  await db
    .prepare("INSERT INTO ext_roles (id, code, name) VALUES (?, ?, ?)")
    .bind(roleId(code), code, name)
    .run();
  return {ok: true};
}

/** Rename a role. The code is the stable identity, so only the label changes. */
export async function renameRbacRole(
  db: D1Database,
  code: string,
  name: string,
): Promise<RoleMutationResult> {
  if (RESERVED_ROLES.has(code)) {
    return {ok: false, reason: "reservedRole"};
  }
  const result = await db
    .prepare("UPDATE ext_roles SET name = ? WHERE code = ?")
    .bind(name, code)
    .run();
  if (!result.success || result.meta?.changes === 0) {
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
): Promise<RoleMutationResult> {
  if (RESERVED_ROLES.has(code)) {
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
  const result = await db
    .prepare("DELETE FROM ext_roles WHERE code = ?")
    .bind(code)
    .run();
  if (!result.success || result.meta?.changes === 0) {
    return {ok: false, reason: "unknownRole"};
  }
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

  const result = await createRbacRole(env.FEED_DB, code, name);
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

  const result = await renameRbacRole(env.FEED_DB, code, name);
  if (!result.ok) {
    return localizedError(
      request,
      `errors.rbac.${result.reason}`,
      result.reason === "unknownRole" ? 404 : 400,
    );
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

  const result = await deleteRbacRole(env.FEED_DB, code);
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
    | {account?: unknown; email?: unknown; name?: unknown; password?: unknown}
    | null;
  // `account` is the current field: it holds either an address or a username.
  // `email` is still accepted so an older dashboard build keeps working.
  const typedAccount = (typeof body?.account === "string" && body.account) ||
    (typeof body?.email === "string" ? body.email : "");
  const account = typeof typedAccount === "string" ? typedAccount.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!account || !name) {
    return localizedError(request, "errors.rbac.invalidNewUser", 400);
  }
  if (validateAdminPassword(password)) {
    return localizedError(request, "errors.password.policy", 400, {
      min: String(MIN_ADMIN_PASSWORD_LENGTH),
    });
  }

  const accountKind = adminAccountKind(account);
  const username = accountKind === "username"
    ? normalizeAdminUsername(account)
    : null;
  let email: string;
  if (accountKind === "email") {
    if (validateAdminEmail(account)) {
      return localizedError(request, "errors.rbac.invalidEmail", 400);
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
    const taken = await env.FEED_DB.prepare(
      "SELECT id FROM auth_user WHERE username = ?",
    ).bind(username).first<{id: string}>();
    if (taken) {
      return localizedError(request, "errors.rbac.usernameTaken", 409);
    }
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

  // Gap D producer (DESIGN §7 / ADR D-010): an admin-provisioned account starts
  // with a forced password change, so the guard's 428 branch is reachable in
  // production. The self-service `/admin/ajax/account/password` endpoint clears
  // this flag after the user sets their own password.
  if (!newUserId) {
    const row = await env.FEED_DB.prepare(
      "SELECT id FROM auth_user WHERE email = ?",
    ).bind(email).first<{id: string}>();
    newUserId = row?.id ?? null;
  }
  if (newUserId) {
    // `ext_user_security` only carries (user_id, must_change_password) — see
    // migration 0028 — so there is no `created_at` column to write here.
    await env.FEED_DB.prepare(
      `INSERT OR IGNORE INTO ext_user_security (user_id, must_change_password)
       VALUES (?, 1)`,
    ).bind(newUserId).run();
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
  const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
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
  const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
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

  const result = await replaceUserRoles(env.FEED_DB, body.userId, codes);
  if (!result.ok) {
    const status = result.reason === "unknownUser" ? 404 : 400;
    return localizedError(request, `errors.rbac.${result.reason}`, status);
  }
  return jsonResponse(await readRbacUsers(env.FEED_DB));
};

export const getAdminRbacBoard: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.SYSTEM_ROLE_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  return jsonResponse(await readRbacBoard(env.FEED_DB));
};

export const updateAdminRbacRole: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.SYSTEM_PERMISSION_MANAGE,
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
  const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
  const deviceId = typeof body?.deviceId === "string" ? body.deviceId.trim() : "";
  if (!userId || !deviceId) {
    return localizedError(request, "errors.rbac.invalidUserAssignment", 400);
  }
  const result = await revokeUserDevice(env.FEED_DB, userId, deviceId);
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
  const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
  const deviceId = typeof body?.deviceId === "string" ? body.deviceId.trim() : "";
  if (!userId || !deviceId) {
    return localizedError(request, "errors.rbac.invalidUserAssignment", 400);
  }
  const result = await restoreUserDevice(env.FEED_DB, userId, deviceId);
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
  );
  if (!revoked) {
    return localizedError(request, "errors.loginCredential.unknown", 404);
  }
  return jsonResponse(
    await readRbacUserLoginCredentials(env.FEED_DB, targetUserId),
  );
};
