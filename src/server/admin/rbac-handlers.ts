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
import {hashPassword} from "better-auth/crypto";

import {jsonResponse, localizedError} from "@/server/http";
import {
  authUserInsertSql,
  credentialAccountStatement,
} from "@/server/auth/account-insert";
import {USER_OWNED_TABLES} from "./user-owned-tables";
import {
  createLoginCredential,
  LoginCredentialLimitError,
  listLoginCredentialsForUser,
  revokeLoginCredential,
} from "@/server/auth/login-credentials";
import {
  requireAudienceGuard,
  requireAuthenticatedRbac,
  requireRbac,
  type RbacLocals,
} from "@/server/rbac/guard";
import {
  auditStatement,
  type PendingAudit,
} from "@/server/rbac/audit";
import {PERMISSION_CODES} from "@/shared/Constants";
import {permissionId, roleId} from "@/server/rbac/seed";
import {readAppRequestQuotaRows} from "@/server/rbac/app-quota";
import {RBAC_WILDCARD} from "@/server/rbac/resolve";
import {
  refreshRoleMembersSnapshotStatements,
  refreshUserSnapshotStatements,
} from "@/server/rbac/snapshot";
import {
  purgeUserAccess,
  purgeUsersAccess,
} from "@/server/cache/identity-cache";
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
  DEFAULT_USER_ROLE,
  isPermissionAudience,
  type PermissionAudience,
  type RbacBoard,
  type RbacUserBoard,
  type SignupSource,
} from "@/shared/Rbac";
import {
  audienceOf,
  buildGrantGroupsFromNodes,
  PERMISSION_NODE_COLUMNS,
  toPermissionNodeRow,
  type PermissionNodeRow,
  type PermissionNodeTableRow,
} from "@/shared/PermissionTreeOps";
import type {AdminDeviceRow} from "@/shared/AppDeviceVersion";

export type {RbacBoard, RbacBoardRole, RbacUser, RbacUserBoard} from "@/shared/Rbac";

/**
 * 单端授权板（ADR-0039 D2）：节点、角色 grants 与权限名目录都按终端归属裁剪，
 * 两端互不可见。
 *
 * - 节点：`WHERE audience = ?` 走 `(audience, kind)` 索引，PC 端约 78 行、
 *   App 端约 12 行。
 * - grants：`ext_role_permissions` 只有 `role_id` / `permission_id`，没有端列，
 *   所以经节点表的 `kind='code'` 叶子 join 出本端的 `permission_id` 集合再裁剪；
 *   不裁剪的话 App 页的角色行会带出桌面码。`*` 通配不属于任何一端，显式放行——
 *   它是 super_admin 拥有全部权限的记法，在任一端都成立，但两端都不给它勾选位。
 * - 目录：只留本端叶子上登记过的码，本端没有挂靠点的码不给勾选机会。
 */
export async function readRbacBoard(
  db: D1Database,
  audience: PermissionAudience,
): Promise<RbacBoard> {
  const [roles, catalog, grants, nodes] = await Promise.all([
    db
      .prepare(
        `SELECT id, code, name, allow_admin_login AS allowAdminLogin,
                is_member AS isMember
         FROM ext_roles ORDER BY code`,
      )
      .all<{
        allowAdminLogin: number | null;
        code: string;
        id: string;
        isMember: number;
        name: string;
      }>(),
    db
      .prepare("SELECT code, name FROM ext_permissions ORDER BY code")
      .all<{code: string; name: string}>(),
    db
      .prepare(
        `SELECT rp.role_id AS roleId, p.code AS code
         FROM ext_role_permissions rp
         JOIN ext_permissions p ON p.id = rp.permission_id
         LEFT JOIN ext_permission_nodes n
           ON n.permission_code = p.code AND n.kind = 'code'
         WHERE p.code = ? OR n.audience = ?`,
      )
      .bind(RBAC_WILDCARD, audience)
      .all<{roleId: string; code: string}>(),
    db
      .prepare(
        `SELECT ${PERMISSION_NODE_COLUMNS}
         FROM ext_permission_nodes WHERE audience = ? ORDER BY sort, code`,
      )
      .bind(audience)
      .all<PermissionNodeTableRow>(),
  ]);

  const byRole = new Map<string, string[]>();
  for (const grant of grants.results ?? []) {
    const list = byRole.get(grant.roleId) ?? [];
    list.push(grant.code);
    byRole.set(grant.roleId, list);
  }

  const nodeRows: PermissionNodeRow[] = (nodes.results ?? []).map(toPermissionNodeRow);
  const scopedCodes = new Set(
    nodeRows
      .filter((row) => row.kind === "code" && row.permissionCode !== null)
      .map((row) => row.permissionCode as string),
  );
  const permissions = (catalog.results ?? [])
    .map((row) => ({code: row.code, name: row.name}))
    .filter((entry) => scopedCodes.has(entry.code));

  // 树现在只来自一张自持表（ADR-0038）：授权视图按节点行的 `(sort, code)`
  // 读序拼出来，原先喂它的菜单联表已从这条读路径上退掉。
  return {
    audience,
    groups: buildGrantGroupsFromNodes(
      nodeRows,
      new Map(permissions.map((entry) => [entry.code, entry.name])),
      audience,
    ),
    permissions,
    roles: (roles.results ?? []).map((row) => ({
      allowAdminLogin: Number(row.allowAdminLogin) === 1,
      code: row.code,
      isMember: Number(row.isMember) === 1,
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
        | "wildcardPermission"
        | "audienceMismatch";
    };

/**
 * 按**单端**整体替换某角色的授权（ADR-0039 D4）。
 *
 * 两处拒绝，都围绕通配码：
 * - `super_admin` 一律不可编辑：它的权限来自 `*`，一旦被清掉，所有管理员
 *   都进不了后台。
 * - `*` 不可授予其他角色：那等于造出第二个超级管理员，`system:role:manage`
 *   就此成为提权路径。看板里这一行是隐藏的，服务端仍须拒绝——否则伪造请求
 *   可以绕过界面。
 *
 * `audience` 限定写入范围：提交的每个码都必须属于该端（否则 fail-closed），
 * 且只替换该端的授权行。`ext_role_permissions` 没有 audience 列，作用域用
 * 节点表 `kind='code'` 叶子上的子查询表达。若改成 `DELETE ... WHERE role_id = ?`
 * 整体删除，另一端的授权会被一起清掉——editor 持有两条 App 码，下一次有人
 * 保存 PC 端时就会这样丢掉。
 */
export async function replaceRolePermissions(
  db: D1Database,
  roleCode: string,
  codes: string[],
  audience: PermissionAudience,
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

  // 归属校验：提交的码必须全部属于本次保存的那一端。判定走共享的
  // `audienceOf()`——某码归哪端只有「它那条 kind='code' 叶子」一个来源，
  // 这里不另写一份推导。缺叶子的码得 `null`，按不一致处理（不做默认端的猜测）。
  const leaves = await db
    .prepare(
      `SELECT ${PERMISSION_NODE_COLUMNS} FROM ext_permission_nodes
       WHERE kind = 'code'`,
    )
    .all<PermissionNodeTableRow>();
  const leafRows = (leaves.results ?? []).map(toPermissionNodeRow);
  for (const code of codes) {
    if (audienceOf(code, leafRows) !== audience) {
      return {ok: false, reason: "audienceMismatch"};
    }
  }

  // 差量写（ADR-0049 D13①）：查回该角色在本端的现有码集，只删移除、只增
  // 新增——保存未变更的角色从 1+N 行写降为 0 行写。role_id → 现有码的映射
  // 一条 JOIN 读回。
  const current = await db
    .prepare(
      `SELECT p.code AS code FROM ext_role_permissions rp
       JOIN ext_permissions p ON p.id = rp.permission_id
       JOIN ext_permission_nodes n ON n.permission_code = p.code
       WHERE rp.role_id = ? AND n.kind = 'code' AND n.audience = ?`,
    )
    .bind(role.id, audience)
    .all<{code: string}>();
  const currentCodes = new Set((current.results ?? []).map((row) => row.code));
  const nextCodes = new Set(codes);
  const removed = [...currentCodes].filter((code) => !nextCodes.has(code));
  const added = codes.filter((code) => !currentCodes.has(code));

  await db.batch([
    ...(removed.length > 0
      ? [
        db
          .prepare(
            `DELETE FROM ext_role_permissions
             WHERE role_id = ?
               AND permission_id IN (
                 SELECT p.id FROM ext_permissions p
                 JOIN ext_permission_nodes n ON n.permission_code = p.code
                 WHERE n.kind = 'code' AND n.audience = ?
                   AND p.code IN (${removed.map(() => "?").join(", ")})
               )`,
          )
          .bind(role.id, audience, ...removed),
      ]
      : []),
    ...added.map((code) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id)
           VALUES (?, ?)`,
        )
        .bind(role.id, permissionId(code)),
    ),
    // 权限码变了，持这个角色的账号快照要跟着变（ADR-0053）。排在授权改动之后，
    // 聚合才看得到新值。
    ...refreshRoleMembersSnapshotStatements(db, role.id),
    // Same batch: the grants and the record of who changed them are atomic.
    ...(audit ? [auditStatement(db, audit)] : []),
  ]);
  await purgeRoleMembersAccess(db, role.id);
  return {ok: true};
}

/** 清掉持有该角色的全部账号的角色对象缓存（方案 4.3）。 */
async function purgeRoleMembersAccess(
  db: D1Database,
  roleId: string,
): Promise<void> {
  const members = await db
    .prepare("SELECT user_id FROM ext_user_roles WHERE role_id = ?")
    .bind(roleId)
    .all<{user_id: string}>();
  await purgeUsersAccess((members.results ?? []).map((row) => row.user_id));
}

/** Accounts, the roles granted to them, and the roles available to grant. */
/**
 * 把原始 `auth_user.signup_source` 值收敛到已知集合（ADR-0014 §8）。
 * `null`（库没跑迁移 0157）与未知值都回退为 `"email"`，后台用户手风琴
 * 不会渲染出未映射的分类。
 */
function toSignupSource(raw: string | null): SignupSource {
  return raw === "qq" || raw === "admin" ? raw : "email";
}

export async function readRbacUsers(db: D1Database): Promise<RbacUserBoard> {
  const [accounts, roles, grants] = await Promise.all([
    db
      .prepare(
        `SELECT id, name, email, banned, username, displayUsername, signup_source
         FROM auth_user ORDER BY email`,
      )
      .all<{
        banned: number | null;
        displayUsername: string | null;
        email: string;
        id: string;
        name: string;
        signup_source: string | null;
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
      name: row.name,
      roles: (byUser.get(row.id) ?? []).sort(),
      // Fall back to "email" so a DB that never ran migration 0157 (no
      // signup_source column yet) doesn't break the admin board. Anything
      // outside the known set also collapses to "email" so the UI accordion
      // never sees an unmapped category.
      signupSource: toSignupSource(row.signup_source),
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
  // LIMIT 上界（ADR-0049 D8）：设备行随客户端换 id 增长（清理任务只删
  // revoked 残留），面板按最近活跃截断 500 行——超出部分的设备仍能被搜索
  // 定位（按用户查），只是不进全量列表。
  const rows = await db
    .prepare(
      `SELECT d.device_id AS deviceId, d.user_id AS userId,
              COALESCE(u.displayUsername, u.username) AS username,
              u.email AS email, d.status AS status,
              d.last_seen_at AS lastSeenAt, d.created_at AS createdAt
       FROM ext_user_devices d
       JOIN auth_user u ON u.id = d.user_id
       ${clause}
       ORDER BY d.last_seen_at DESC
       LIMIT 500`,
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
    // 角色分配变了，这个账号的权限快照跟着变（ADR-0053）。清空角色时
    // `roleCodes` 是空数组，聚合命中 0 行，这两条里的 DELETE 生效、INSERT 不插，
    // 结果就是「没有快照行 = 无权限」。
    ...refreshUserSnapshotStatements(db, userId),
    // The audit row rides the same batch, so the change and its record are
    // atomic: either both land or neither does.
    ...(audit ? [auditStatement(db, audit)] : []),
  ]);
  await purgeUserAccess(userId);
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
      | "invalidRole"
      | "loginLocked";
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
      .prepare(
        // 两个布尔都显式写 0：`allow_admin_login` 的列默认值是 1（0132 给种子角色
        // 留的），新建角色默认不允许登录后台；`is_member` 默认不是会员。
        `INSERT INTO ext_roles (id, code, name, allow_admin_login, is_member)
         VALUES (?, ?, ?, 0, 0)`,
      )
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
 * 改角色的「登录后台」开关（`ext_roles.allow_admin_login`）。
 *
 * `super_admin` 固定为允许：它是唯一持有 `*` 的角色，关掉就等于把整个后台锁在
 * 门外，而且没有第二个入口能改回来。
 *
 * 关掉只挡后台入口，不动授权行：重新允许后，角色原有的授权原样还在。持有该
 * 角色的账号下一次请求就会被拒（中间件与端点守卫各读一次），不需要等重新登录。
 */
export async function setRbacRoleAdminLogin(
  db: D1Database,
  code: string,
  allow: boolean,
  audit?: PendingAudit,
): Promise<RoleMutationResult> {
  if (code === "super_admin" && !allow) {
    return {ok: false, reason: "loginLocked"};
  }
  const role = await db
    .prepare("SELECT id FROM ext_roles WHERE code = ?")
    .bind(code)
    .first<{id: string}>();
  if (!role) {
    return {ok: false, reason: "unknownRole"};
  }
  await db.batch([
    db.prepare(
      `UPDATE ext_roles
       SET allow_admin_login = ?, updated_at = CURRENT_TIMESTAMP
       WHERE code = ?`,
    ).bind(allow ? 1 : 0, code),
    // 「允许登录后台」进了权限快照（ADR-0053 约束 2），持这个角色的账号要重算。
    ...refreshRoleMembersSnapshotStatements(db, role.id),
    // 同一批：开关与「谁改的」一起提交。
    ...(audit ? [auditStatement(db, audit)] : []),
  ]);
  return {ok: true};
}

/**
 * 改角色的「会员」标记（`ext_roles.is_member`，migration 0144）。
 *
 * 该标记驱动 App 侧会员档：鉴权时随权限快照（ADR-0053）一并读出，四个 App
 * 内容端点经 `locals.appMember` 选内容桶（改它下一次请求即生效，缓存键只含
 * 档位、不含身份）。与「登录后台」不同，它对 `super_admin` 同样开放——没有一个
 * 必须固定的取值。
 */
export async function setRbacRoleMember(
  db: D1Database,
  code: string,
  member: boolean,
  audit?: PendingAudit,
): Promise<RoleMutationResult> {
  const role = await db
    .prepare("SELECT id FROM ext_roles WHERE code = ?")
    .bind(code)
    .first<{id: string}>();
  if (!role) {
    return {ok: false, reason: "unknownRole"};
  }
  await db.batch([
    db.prepare(
      `UPDATE ext_roles
       SET is_member = ?, updated_at = CURRENT_TIMESTAMP
       WHERE code = ?`,
    ).bind(member ? 1 : 0, code),
    // 会员标记进了权限快照（ADR-0053 约束 2），持这个角色的账号要重算。
    ...refreshRoleMembersSnapshotStatements(db, role.id),
    // 同一批：开关与「谁改的」一起提交。
    ...(audit ? [auditStatement(db, audit)] : []),
  ]);
  await purgeRoleMembersAccess(db, role.id);
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
      `INSERT INTO ext_roles
         (id, code, name, allow_admin_login, is_member, created_at, updated_at)
       SELECT ?, ?, name, allow_admin_login, is_member, created_at, CURRENT_TIMESTAMP
       FROM ext_roles WHERE id = ?`,
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
  return jsonResponse(await readRbacBoard(env.FEED_DB, "desktop"));
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
  return jsonResponse(await readRbacBoard(env.FEED_DB, "desktop"));
};

/**
 * 「登录后台」开关的端点。与其他角色改动同一道门（`system:role:manage`），
 * 返回 PC 板子——角色清单两端同源，前端拿它整表刷新。
 */
export const updateAdminRbacRoleLogin: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.SYSTEM_ROLE_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;

  const body = await request.json().catch(() => null) as
    | {allow?: unknown; code?: unknown}
    | null;
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  // 只认布尔：字符串 "false" 是真值，放过它会把「不允许」静默存成允许。
  const allow = body?.allow;
  if (!code || typeof allow !== "boolean") {
    return localizedError(request, "errors.rbac.invalidRole", 400);
  }

  const result = await setRbacRoleAdminLogin(env.FEED_DB, code, allow, {
    action: "role.login",
    actor: locals.authUser,
    detail: allow ? "allow" : "deny",
    target: code,
  });
  if (!result.ok) {
    return localizedError(
      request,
      `errors.rbac.${result.reason}`,
      result.reason === "unknownRole" ? 404 : 400,
    );
  }
  return jsonResponse(await readRbacBoard(env.FEED_DB, "desktop"));
};

/**
 * 「会员」标记的端点。与其他角色改动同一道门（`system:role:manage`），返回 PC
 * 板子——角色清单两端同源，前端拿它整表刷新。
 */
export const updateAdminRbacRoleMember: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.SYSTEM_ROLE_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;

  const body = await request.json().catch(() => null) as
    | {code?: unknown; member?: unknown}
    | null;
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  // 只认布尔：字符串 "false" 是真值，放过它会把「非会员」静默存成会员。
  const member = body?.member;
  if (!code || typeof member !== "boolean") {
    return localizedError(request, "errors.rbac.invalidRole", 400);
  }

  const result = await setRbacRoleMember(env.FEED_DB, code, member, {
    action: "role.member",
    actor: locals.authUser,
    detail: member ? "member" : "non-member",
    target: code,
  });
  if (!result.ok) {
    return localizedError(
      request,
      `errors.rbac.${result.reason}`,
      result.reason === "unknownRole" ? 404 : 400,
    );
  }
  return jsonResponse(await readRbacBoard(env.FEED_DB, "desktop"));
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
  return jsonResponse(await readRbacBoard(env.FEED_DB, "desktop"));
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
  return jsonResponse(await readRbacBoard(env.FEED_DB, "desktop"));
};

/**
 * Account lifecycle, written straight to D1.
 *
 * `auth_user` and its credential row are inserted in the same batch as the role
 * grants, the permission snapshot and the audit trail: a failure in any of them
 * rolls the whole thing back, so there is no window where an account exists
 * without its roles. Password hashing still goes through `hashPassword`
 * (`better-auth/crypto`), which `bootstrap.ts` and `password-setup.ts` already
 * call directly.
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

  // 唯一性检查：用户名与邮箱是账号的两条登录凭据，冲突要在写入前返回 409，
  // 不能拖到写库后再返回通用失败。上面的取值都已过 `normalizeAdminUsername` /
  // `normalizeAdminEmail`，库里存的也是同一小写形式，等值比较会把 "Bob" 与
  // "bob" 认成同一账号。邮箱检查同时覆盖只有用户名、使用占位邮箱的账号。
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

  const userId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const passwordHash = await hashPassword(password);
  const createAudit: PendingAudit = {
    action: "user.create",
    actor: locals.authUser,
    detail: roleCodes.join(","),
    target: userId,
  };
  // 建号、凭证、角色授予、权限快照、审计在同一批里提交：任何一条失败都整批回滚，
  // 不会留下「账号已建、角色没授予」的半成品。
  //
  // `username` / `displayUsername` 的归一化与唯一性原本由 username 插件的
  // `user.create.before` 钩子代做。插件已移除，改由本路径自己保证：上面
  // `normalizeAdminUsername` 与 `usernameIsTaken` 已在前置执行，写入值与校验值
  // 同一形式。这里没有钩子兜底，新增写路径时必须自己补这两步。
  //
  // 角色分配不需要先 `DELETE`：`userId` 是刚生成的，`INSERT OR IGNORE` 已覆盖
  // 重复键。
  await env.FEED_DB.batch([
    env.FEED_DB.prepare(
      authUserInsertSql({
        signupSource: "admin",
        withUsername: username !== null,
      }),
    ).bind(
      userId,
      name,
      email,
      timestamp,
      timestamp,
      ...(username === null ? [] : [username, account]),
    ),
    credentialAccountStatement(env.FEED_DB, {
      accountId,
      passwordHash,
      timestamp,
      userId,
    }),
    ...roleCodes.map((code) =>
      env.FEED_DB.prepare(
        "INSERT OR IGNORE INTO ext_user_roles (user_id, role_id) VALUES (?, ?)",
      ).bind(userId, roleId(code)),
    ),
    // 上面刚写好角色分配，权限快照在同批里一并生成（ADR-0053）。缺了它，
    // 新账号第一次进后台就是 403。
    ...refreshUserSnapshotStatements(env.FEED_DB, userId),
    auditStatement(env.FEED_DB, createAudit),
  ]);
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

  // 19 条语句一个批次：17 张从属表逐张删，`auth_user` 收尾，再接审计。
  //
  // 逐张显式删，不只依赖 ON DELETE CASCADE：D1 的外键强制开关不由本仓控制，
  // 而 `ext_api_key_owners` 与 `ext_login_credentials` 本身就是 NO ACTION。
  // 多删一次是幂等的；漏删会让同名 id 重建后继承旧的密钥归属与权限。
  const deleteAudit: PendingAudit = {
    action: "user.delete",
    actor: locals.authUser,
    target: userId,
  };
  const results = await env.FEED_DB.batch([
    ...USER_OWNED_TABLES.map(({column, table}) =>
      env.FEED_DB.prepare(`DELETE FROM "${table}" WHERE "${column}" = ?`)
        .bind(userId),
    ),
    env.FEED_DB.prepare('DELETE FROM "auth_user" WHERE "id" = ?').bind(userId),
    auditStatement(env.FEED_DB, deleteAudit),
  ]);
  // 账号在读取与删除之间消失时，`auth_user` 那条命中 0 行，必须自己判。
  if ((results[USER_OWNED_TABLES.length]?.meta.changes ?? 0) !== 1) {
    return localizedError(request, "errors.rbac.unknownUser", 404);
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

  const banAudit: PendingAudit = {
    action: body.banned ? "user.ban" : "user.unban",
    actor: locals.authUser,
    target: userId,
  };
  const timestamp = new Date().toISOString();
  // 封禁 = 收回该账号的全部身份凭据，与置标志同批提交：标志写上了而凭据还在，
  // 封禁就等于没做。
  //
  // 解封只把标志置回，被吊销的凭据不会复活——`mflc_` 要重新签发，第三方应用要
  // 重新授权，后台要重新登录。这是严格封禁的语义，运营侧不能把它当成可逆的暂停。
  //
  // 自我封禁会把自己登出：改密路径靠 `keepSessionId` 保住操作者的当前会话，
  // 这条路径刻意不保。唯一超管封自己在上面已被 `lastSuperAdmin` 挡住。
  const banStatements = body.banned
    ? [
      env.FEED_DB.prepare(
        'UPDATE "auth_user" SET "banned" = 1, "banReason" = NULL, ' +
          '"updatedAt" = ? WHERE "id" = ?',
      ).bind(timestamp, userId),
      ...revokeUserDerivedStatements(env.FEED_DB, userId),
    ]
    : [
      env.FEED_DB.prepare(
        'UPDATE "auth_user" SET "banned" = 0, "banReason" = NULL, ' +
          '"updatedAt" = ? WHERE "id" = ?',
      ).bind(timestamp, userId),
    ];
  const results = await env.FEED_DB.batch([
    ...banStatements,
    auditStatement(env.FEED_DB, banAudit),
  ]);
  // 账号不存在时 UPDATE 命中 0 行。以前插件的 ban-user 会抛错，这里必须自己判。
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    return localizedError(request, "errors.rbac.unknownUser", 404);
  }
  return jsonResponse(await readRbacUsers(env.FEED_DB));
};

/** Pull a trimmed `userId` string out of an RBAC action body, or "" if absent. */
function parseRbacUserId(body: {userId?: unknown} | null): string {
  return typeof body?.userId === "string" ? body.userId.trim() : "";
}

/**
 * 用户名是否已被占用。
 *
 * 调用方传入的值已过 `normalizeAdminUsername`，username plugin 写入数据库的也是
 * 同一小写形式，等值比较直接走 `auth_user_username` 唯一索引，仅读取 1 条
 * 索引项与 1 行表数据。对列使用 `lower()` 包裹时查询计划是 `SCAN auth_user`，
 * 每次查重读取全部账号行（本地 4 行 / 4,096 字节）。
 */
async function usernameIsTaken(
  database: D1Database,
  username: string,
): Promise<boolean> {
  const row = await database.prepare(
    "SELECT id FROM auth_user WHERE username = ?",
  ).bind(username).first<{id: string}>();
  return Boolean(row);
}

/**
 * 邮箱是否已被某个账号使用；编辑账号时用 `exceptUserId` 跳过账号自己。
 *
 * `email` 已由 `normalizeAdminEmail` 归一化，Better Auth 与初始化路径写入的
 * 也是小写形式，等值比较走 email 列的 UNIQUE 约束索引
 * `sqlite_autoindex_auth_user_2`（`0002_better_auth.sql:4` 的列级 UNIQUE，
 * `sqlite_autoindex_auth_user_1` 已被 `id` 的 TEXT PRIMARY KEY 占用），仅读取 1 条索引项与
 * 1 行表数据。对列使用 `lower()` 包裹时查询计划是 `SCAN auth_user`（本地 4 行 /
 * 4,096 字节）。
 */
async function emailIsTaken(
  database: D1Database,
  email: string,
  exceptUserId?: string,
): Promise<boolean> {
  const statement = exceptUserId
    ? database.prepare(
      "SELECT id FROM auth_user WHERE email = ? AND id <> ?",
    ).bind(email, exceptUserId)
    : database.prepare(
      "SELECT id FROM auth_user WHERE email = ?",
    ).bind(email);
  const row = await statement.first<{id: string}>();
  return Boolean(row);
}

/**
 * 派生凭据的吊销语句。封禁与改密共用这一份清单，吊销范围不会各走一套。
 *
 * `auth_user` / `auth_account` 行原样保留，收回的只是*派生*凭据：后台会话、
 * `mflc_` 登录凭证、OAuth 授权四表。
 *
 * `keepSessionId` 留一个后台会话——管理员重置自己的口令时，不能让当前请求的
 * 会话一起失效。
 */
function revokeUserDerivedStatements(
  database: D1Database,
  userId: string,
  keepSessionId?: string,
): D1PreparedStatement[] {
  const sessionDelete = keepSessionId
    ? database.prepare('DELETE FROM "auth_session" WHERE "userId" = ? AND "id" <> ?')
      .bind(userId, keepSessionId)
    : database.prepare('DELETE FROM "auth_session" WHERE "userId" = ?').bind(userId);
  return [
    sessionDelete,
    database.prepare('DELETE FROM "oauth_access_token" WHERE "userId" = ?').bind(userId),
    database.prepare('DELETE FROM "oauth_refresh_token" WHERE "userId" = ?').bind(userId),
    database.prepare('DELETE FROM "oauth_consent" WHERE "userId" = ?').bind(userId),
    database.prepare('DELETE FROM "oauth_connection" WHERE "userId" = ?').bind(userId),
    database.prepare('DELETE FROM "ext_login_credentials" WHERE "user_id" = ?').bind(userId),
  ];
}

/**
 * 单独一批跑吊销。需要与别的语句同批时改用 {@link revokeUserDerivedStatements}。
 *
 * 覆盖范围比 CLI 的 `reset-password`（`manage-cli/lib/auth.ts` 的
 * `passwordResetSql`，会话 + OAuth 四表）多一张 `ext_login_credentials`：
 * 账号疑似失陷后重置口令，若第三方授权或 API 凭证还活着，重置就失去意义。
 */
async function revokeUserDerivedCredentials(
  database: D1Database,
  userId: string,
  keepSessionId?: string,
): Promise<void> {
  await database.batch(
    revokeUserDerivedStatements(database, userId, keepSessionId),
  );
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
  const passwordHash = await hashPassword(newPassword);
  const timestamp = new Date().toISOString();
  // 改密与审计同批提交：口令换了而没有流水，事后查不出谁改的。
  const resetAudit: PendingAudit = {
    action: "user.passwordReset",
    actor: locals.authUser,
    target: userId,
  };
  const results = await env.FEED_DB.batch([
    env.FEED_DB
      .prepare(
        'UPDATE "auth_account" SET "password" = ?, "updatedAt" = ? ' +
          'WHERE "userId" = ? AND "providerId" = \'credential\'',
      )
      .bind(passwordHash, timestamp, userId),
    auditStatement(env.FEED_DB, resetAudit),
  ]);
  // 没有凭证行时 UPDATE 会静默命中 0 行。以前走插件会抛错，这里必须自己判，
  // 否则「改密成功」的响应背后什么都没改。
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    return localizedError(request, "errors.rbac.unknownUser", 404);
  }
  // 口令行之外的一切派生凭据都要收回：会话、OAuth 授权、`mflc_` 凭证，
  // 否则改密的效力只在新登录上生效。自改密保当前会话（否则管理员在本请求中途
  // 被登出）；改别人的一律全清。识别不出当前会话时全清（fail closed）。
  await revokeUserDerivedCredentials(
    env.FEED_DB,
    userId,
    locals.authUser?.id === userId ? locals.authSession?.id : undefined,
  );
  return jsonResponse(await readRbacUsers(env.FEED_DB));
};

/** 后台可改的资料列。SET 子句的键集合就是这张清单。 */
type ProfileField = "displayUsername" | "email" | "name" | "username";

/**
 * Admin edit of an account's display name, email, and/or username.
 *
 * 三个字段都直写 `auth_user`：只对实际提交的字段拼 SET 子句，没提交的列不动。
 * 邮箱唯一性在这里先查一次，好返回准确的 `emailTaken`（409），不必等写入抛错
 * 再翻译。用户名是单向门：只有用户名列出现之前建的账号可以被赋予一次，已有的
 * 用户名永不覆盖——登录解析就靠它。只改 `name`/`email`/`username`，不附带强制
 * 改密，与本地「首次登录不强制改密」的口径一致。
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
  // 键限定在可改的四列：SET 子句照这里的键拼，键集合就是列白名单。
  const data: Partial<Record<ProfileField, string>> = {};
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
    // 与除本账号外的所有账号比较；归一化后的地址与库里的行同一形式，
    // 大小写混写也会返回 409，不会拖到 `adminUpdateUser` 才返回通用失败。
    if (await emailIsTaken(env.FEED_DB, email, userId)) {
      return localizedError(request, "errors.rbac.emailTaken", 409);
    }
    data.email = email;
  }
  const assignments: string[] = [];
  const values: string[] = [];
  for (const [column, value] of Object.entries(data)) {
    if (value === undefined) continue;
    assignments.push(`"${column}" = ?`);
    values.push(value);
  }
  assignments.push('"updatedAt" = ?');
  values.push(new Date().toISOString());
  values.push(userId);
  const profileAudit: PendingAudit = {
    action: "user.profile",
    actor: locals.authUser,
    detail: Object.keys(data).join(","),
    target: userId,
  };
  const results = await env.FEED_DB.batch([
    env.FEED_DB
      .prepare(`UPDATE "auth_user" SET ${assignments.join(", ")} WHERE "id" = ?`)
      .bind(...values),
    auditStatement(env.FEED_DB, profileAudit),
  ]);
  // 账号在读取与写入之间被删时 UPDATE 命中 0 行，必须自己判，否则响应说改成功。
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    return localizedError(request, "errors.rbac.unknownUser", 404);
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

/** 授权保存请求体的字节上限：内容是一个角色码加单端全部码，远小于此值。 */
const MAX_ASSIGNMENT_BODY_BYTES = 64 * 1024;

/**
 * 按单端保存某角色的授权（ADR-0039 D3/D4）。
 *
 * 请求体带着它来自哪一端（`audience`），守卫码由这个值选定：PC 端要
 * `system:role:manage`，App 端要 `system:app-capability:manage`。守卫码只能
 * 等请求体解析完才知道，所以先跑不需要端归属的那半步——防重放 + 账号门——
 * 未登录、被封、待改密的调用方在读取请求体之前就被挡回去；声明长度再兜一层，
 * 免得为巨大载荷分配内存。授权请求体是一个角色码加单端全部码，远低于上限。
 */
export const updateAdminRbacRole: APIRoute = async ({locals, request}) => {
  const gate = await requireAuthenticatedRbac(locals, request, env.FEED_DB);
  if (gate) return gate;
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_ASSIGNMENT_BODY_BYTES) {
    return localizedError(request, "errors.rbac.invalidAssignment", 400);
  }
  const body = await request.json().catch(() => null) as
    | {audience?: unknown; permissions?: unknown; role?: unknown}
    | null;
  if (
    !body ||
    typeof body.role !== "string" ||
    !Array.isArray(body.permissions) ||
    !isPermissionAudience(body.audience)
  ) {
    return localizedError(request, "errors.rbac.invalidAssignment", 400);
  }
  const audience = body.audience;
  // 防重放已在前面跑过，这里只补权限半步。
  const guard = await requireAudienceGuard(locals, audience, request, env.FEED_DB, {
    skipReplay: true,
  });
  if (guard) return guard;

  const codes = body.permissions.filter(
    (code): code is string => typeof code === "string",
  );

  // 先读当前授权：审计行只有记下「改之前是什么」才有用。范围限在本端，
  // 否则「改之前」会把另一端的码混进来。
  const previous = await env.FEED_DB.prepare(
    "SELECT p.code AS code FROM ext_role_permissions rp " +
      "JOIN ext_roles r ON r.id = rp.role_id " +
      "JOIN ext_permissions p ON p.id = rp.permission_id " +
      "JOIN ext_permission_nodes n ON n.permission_code = p.code AND n.kind = 'code' " +
      "WHERE r.code = ? AND n.audience = ? ORDER BY p.code",
  ).bind(body.role, audience).all<{code: string}>();

  const result = await replaceRolePermissions(
    env.FEED_DB,
    body.role,
    codes,
    audience,
    {
      action: "role.permissions",
      actor: locals.authUser,
      before: (previous.results ?? []).map((row) => row.code).join(","),
      detail: codes.join(","),
      target: body.role,
    },
  );
  if (!result.ok) {
    return localizedError(
      request,
      `errors.rbac.${result.reason}`,
      result.reason === "unknownRole" ? 404 : 400,
    );
  }
  return jsonResponse(await readRbacBoard(env.FEED_DB, audience));
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
  const credentials = await listLoginCredentialsForUser(db, userId);
  // 合并当日 App 用量（ADR-0048 限流计数）进面板 board 视图：一次 IN 查询，
  // 凭证数上界 = 5，远低于 D1 单语句 100 绑定参数上限。配额视图只在此处
  // 组装，鉴权存储层的记录类型不携带它。
  const quotaRows = await readAppRequestQuotaRows(
    db,
    credentials.map((credential) => credential.id),
  );
  return {
    credentials,
    quota: Object.fromEntries(quotaRows),
    userId,
  };
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
