/**
 * RBAC permission resolution for microfeed.
 *
 * Reads the `ext_*` assignment tables and returns the effective permission code
 * set for a user. A `super_admin` role (or any grant of the `*` wildcard) yields
 * a set containing {@link RBAC_WILDCARD}, which the guard treats as full access.
 *
 * Decisions/semantics follow `DESIGN.md` (the permission-model SSOT) and are
 * adapted to microfeed in `MICROFEED_ADAPTATION_PLAN.md`.
 */

import {PERMISSION_CODES} from "@/shared/Constants";

export const RBAC_WILDCARD = "*";

/**
 * The permission rule, in one place: a permission set allows a code when it
 * contains the code itself, or the wildcard.
 *
 * Every authorization decision reads this — the admin guard (`hasPermission` in
 * `guard.ts`), the sessionless credential API (`credential-bearer.ts`) and the
 * App search-permission resolver (`app/permission/search.ts`) all call
 * it. Keeping the rule in one function is what stops those paths from drifting
 * apart: a change to the wildcard semantics (or a future deny layer) lands once
 * and applies everywhere, instead of silently diverging between three copies.
 *
 * A missing/empty set allows nothing, so a `null` set is deny-by-default.
 */
export function permissionsInclude(
  permissions: ReadonlySet<string> | null | undefined,
  code: string,
): boolean {
  return (
    Boolean(permissions?.has(RBAC_WILDCARD)) || Boolean(permissions?.has(code))
  );
}

/**
 * App 端权限板在后台是否对当前账号可见。
 *
 * 与 App 端四个数据端点的守卫码严格一致：只认 `system:app-capability:manage`
 * （通配 `*` 经 {@link permissionsInclude} 一并放行）。刻意不读 `app:` 系列码——
 * 那些是移动端运行时用的业务码，默认会授给 editor，若把它们当成可见性依据，
 * 就会出现「看得到 App 分类标题、点进去却因守卫只认管理码而 403」的破窗。
 *
 * 页面（src/pages/[adminPath]/rbac/index.astro）与 App 端四端点守卫共用
 * `system:app-capability:manage` 这一枚码（守卫经 `audienceGuardCode('app')`
 * 取得同一常量），保证「看不看得到」和「能不能读、改、导出」用的是同一把锁。
 */
export function isAppBoardVisible(
  permissions: ReadonlySet<string> | null | undefined,
): boolean {
  return permissionsInclude(permissions, PERMISSION_CODES.SYSTEM_APP_CAPABILITY_MANAGE);
}

export interface UserAccess {
  /** 该账号全部权限码的并集（多角色合并）。 */
  permissions: Set<string>;
  /**
   * 账号所持角色里是否有「会员」角色（`ext_roles.is_member` 的并集，migration 0144）。
   * 内容端点据此决定要不要收录会员书。
   */
  isMember: boolean;
}

/**
 * 一次查询同时取回权限码与会员标记——鉴权时本来就要查角色，会员标记搭同一趟车，
 * 内容端点不必再查一次。
 *
 * 用 LEFT JOIN 保留没有授权行的角色（比如刚建的空角色）：它也要参与会员并集，
 * 内连接会把它整行滤掉。`p.code` 因此可能为 NULL，跳过即可。
 *
 * 读代价（2026-10-22 本机快照 EXPLAIN QUERY PLAN）：四个访问点全走索引，无表扫描——
 * `ur` 走 `ext_user_roles` 主键 `(user_id, role_id)`（覆盖索引），`r` / `p` 走各自
 * 主键，`rp` 走 `ext_role_permissions` 主键 `(role_id, permission_id)`（覆盖索引）。
 * 返回行数 = 该账号角色数 × 每个角色的授权数（本机 4 角色 / 62 条授权，几十行量级）。
 */
export async function resolveUserAccess(
  db: D1Database,
  userId: string,
): Promise<UserAccess> {
  const result = await db
    .prepare(
      `SELECT DISTINCT p.code AS code, r.is_member AS isMember
       FROM ext_user_roles ur
       JOIN ext_roles r ON r.id = ur.role_id
       LEFT JOIN ext_role_permissions rp ON rp.role_id = ur.role_id
       LEFT JOIN ext_permissions p ON p.id = rp.permission_id
       WHERE ur.user_id = ?`,
    )
    .bind(userId)
    .all<{code: string | null; isMember: number | null}>();

  const permissions = new Set<string>();
  let isMember = false;
  for (const row of result.results ?? []) {
    if (row.code !== null) permissions.add(row.code);
    if (Number(row.isMember) === 1) isMember = true;
  }
  return {permissions, isMember};
}

/** 只要权限码的旧入口；会员标记见 {@link resolveUserAccess}。 */
export async function resolveUserPermissions(
  db: D1Database,
  userId: string,
): Promise<Set<string>> {
  return (await resolveUserAccess(db, userId)).permissions;
}

export interface RbacResolved {
  permissions: Set<string>;
  /**
   * 账号所持角色是否允许登录后台（`ext_roles.allow_admin_login` 的并集）。
   * 只作用于后台入口：App 内容接口按登录凭证鉴权，不读这一列。
   */
  adminLoginAllowed: boolean;
  /**
   * Whether the account is flagged for a forced password change
   * (`ext_user_security.must_change_password`).
   *
   * ⚠️ **Dormant today**: no code path writes the flag to 1 — migration 0042
   * cleared every row, and this deployment does not force a change on first
   * sign-in. The guard keeps its 428 branch so the gate is already wired if that
   * policy returns, but nothing can currently trigger it.
   */
  mustChangePassword: boolean;
  deviceRevoked: boolean;
  banned: boolean;
}

/**
 * The first gate of the ADR decision chain, asked by every path that has just
 * established *which account* is calling (session, signed call, sessionless
 * credential): an account must exist and must not be flagged `banned` in
 * `auth_user`.
 *
 * Both conditions live here so a newly added authentication path cannot forget
 * either half. The flag is read from the table rather than off
 * `locals.authUser`, which is typed as the base Better Auth `User` and does not
 * carry the admin plugin's fields.
 */
export async function accountIsBlocked(
  db: D1Database,
  userId: string,
): Promise<boolean> {
  const account = await db
    .prepare("SELECT banned AS flag FROM auth_user WHERE id = ?")
    .bind(userId)
    .first<{flag: number | null}>();
  if (!account) return true;
  return Number(account.flag) === 1;
}

/**
 * The device identity carried by a request, or `null` when absent/invalid.
 *
 * The header is attacker-controlled, so it is validated before it can reach the
 * device table: an unbounded or exotic value must never be upserted as a device
 * identity (B15). An invalid header is treated as absent — the web admin sends
 * no device header at all, so this only affects API clients.
 */
export function deviceIdFromRequest(request: Request): string | null {
  const header = request.headers.get("x-device-id");
  return header !== null &&
      header.length <= 64 &&
      /^[A-Za-z0-9_-]+$/.test(header)
    ? header
    : null;
}

/**
 * Is the device behind this request revoked for this account?
 *
 * Split out of {@link resolveRbacContext} so the App content path
 * (`/api/AppBookRequest/*`) can enforce revocation too — that path never called
 * `resolveRbacContext`, which left "revoked" devices still reading data
 * (ADR-0006).
 */
export async function isDeviceRevoked(
  db: D1Database,
  userId: string,
  request: Request,
): Promise<boolean> {
  const deviceId = deviceIdFromRequest(request);
  if (!deviceId) return false;
  const device = await db
    .prepare(
      "SELECT status FROM ext_user_devices WHERE user_id = ? AND device_id = ?",
    )
    .bind(userId, deviceId)
    .first<{status: string}>();
  return Boolean(device && device.status === "revoked");
}

/**
 * Upsert the device behind this request for this account.
 *
 * ⚠️ `ON CONFLICT … DO UPDATE SET last_seen_at` deliberately updates **only**
 * `last_seen_at`. Writing `status = 'active'` here would silently lift a
 * revocation on the next request (CONTEXT「设备登记」不变量).
 */
export async function registerUserDevice(
  db: D1Database,
  userId: string,
  request: Request,
): Promise<void> {
  const deviceId = deviceIdFromRequest(request);
  if (!deviceId) return;
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO ext_user_devices (user_id, device_id, last_seen_at, status, created_at)
       VALUES (?, ?, ?, 'active', ?)
       ON CONFLICT(user_id, device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    )
    .bind(userId, deviceId, now, now)
    .run();
  // 登录日志**不**在这里写：本函数在每个鉴权请求上都会跑，在那里计数会把「登录次数」
  // 变成「请求次数」，而且它在身份验证之后、覆盖不到未登录启动。写入点已改到
  // App 的版本检查（`GET /api/app/version`，需求 3 追加）——见 login-log.ts。
}

/**
 * 账号能否进入后台：由所持角色的「登录后台」开关决定（`ext_roles` 的
 * `allow_admin_login`）。
 *
 * 多角色取并集——任一角色允许即允许，与 {@link resolveUserPermissions} 的并集
 * 口径一致。**没有任何角色**的账号不设限：这一列是角色挂上的否决位，不是一份
 * 准入名单，账号在分配角色之前不该被它挡住。
 *
 * 只服务后台路径。App 内容接口按登录凭证鉴权，与这一列无关——关掉登录后台
 * 不该让一个 App 账号的连接凭证失效。
 */
export async function userMayEnterAdmin(
  db: D1Database,
  userId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS roles,
              COALESCE(MAX(r.allow_admin_login), 1) AS allowed
       FROM ext_user_roles ur
       LEFT JOIN ext_roles r ON r.id = ur.role_id
       WHERE ur.user_id = ?`,
    )
    .bind(userId)
    .first<{allowed: number | null; roles: number}>();
  if (!row || Number(row.roles) === 0) return true;
  return Number(row.allowed) === 1;
}

/**
 * Resolve the full RBAC context for an authenticated session and, when the
 * caller supplies an `X-Device-Id` header, upsert the device row.
 *
 * Device capture lives here (called from the middleware login flow) and never
 * inside Better Auth — D-09 keeps `better-auth.ts` untouched.
 */
export async function resolveRbacContext(
  db: D1Database,
  userId: string,
  request: Request,
): Promise<RbacResolved> {
  const [permissions, adminLoginAllowed] = await Promise.all([
    resolveUserPermissions(db, userId),
    userMayEnterAdmin(db, userId),
  ]);

  const banned = await accountIsBlocked(db, userId);

  let mustChangePassword = false;
  const security = await db
    .prepare(
      "SELECT must_change_password AS flag FROM ext_user_security WHERE user_id = ?",
    )
    .bind(userId)
    .first<{flag: number}>();
  if (security && security.flag === 1) {
    mustChangePassword = true;
  }

  // Revocation is checked before the upsert, so a revoked device stays revoked.
  const deviceRevoked = await isDeviceRevoked(db, userId, request);
  await registerUserDevice(db, userId, request);

  return {permissions, adminLoginAllowed, mustChangePassword, deviceRevoked, banned};
}
