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

  let deviceRevoked = false;
  const deviceId = request.headers.get("x-device-id");
  if (deviceId) {
    const device = await db
      .prepare(
        "SELECT status FROM ext_user_devices WHERE user_id = ? AND device_id = ?",
      )
      .bind(userId, deviceId)
      .first<{status: string}>();
    if (device && device.status === "revoked") {
      deviceRevoked = true;
    }
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO ext_user_devices (user_id, device_id, last_seen_at, status, created_at)
         VALUES (?, ?, ?, 'active', ?)
         ON CONFLICT(user_id, device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      )
      .bind(userId, deviceId, now, now)
      .run();
  }

  return {permissions, mustChangePassword, deviceRevoked, banned};
}
