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

export const RBAC_WILDCARD = "*";

export async function resolveUserPermissions(
  db: D1Database,
  userId: string,
): Promise<Set<string>> {
  const result = await db
    .prepare(
      `SELECT DISTINCT p.code AS code
       FROM ext_user_roles ur
       JOIN ext_role_permissions rp ON rp.role_id = ur.role_id
       JOIN ext_permissions p ON p.id = rp.permission_id
       WHERE ur.user_id = ?`,
    )
    .bind(userId)
    .all<{code: string}>();

  const permissions = new Set<string>();
  for (const row of result.results ?? []) {
    permissions.add(row.code);
  }
  return permissions;
}

export interface RbacResolved {
  permissions: Set<string>;
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
  const permissions = await resolveUserPermissions(db, userId);

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

  return {permissions, mustChangePassword, deviceRevoked, banned};
}
