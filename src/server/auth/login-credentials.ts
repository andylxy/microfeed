/**
 * Login credential storage + verification.
 *
 * Shared by three callers:
 *  - the dashboard (admin user-management page and the account page), which
 *    lists / issues / revokes a user's tokens,
 *  - the credential sign-in endpoint, which exchanges a token for a session,
 *  - the public-API bearer path, which resolves a token to its owner.
 *
 * Storage note: the plaintext token is persisted in `secret` because the
 * requirement is to be able to re-display and copy it at any time. Possession of
 * the token is therefore sufficient to authenticate, which is why revocation is
 * the primary control and why the sign-in endpoint is rate limited.
 */

import {auditStatement, type PendingAudit} from "@/server/rbac/audit";
import {sha256Hex} from "@/shared/crypto";
import {
  LOGIN_CREDENTIAL_PREFIX,
  MAX_LOGIN_CREDENTIALS_PER_USER,
  type LoginCredentialRecord,
} from "@/shared/LoginCredential";

interface LoginCredentialRow {
  created_at_ms: number;
  expires_at_ms: number | null;
  id: string;
  last_used_at_ms: number | null;
  name: string;
  revoked: number | null;
  secret: string;
  user_id: string;
}

export class LoginCredentialLimitError extends Error {
  constructor() {
    super(
      `A user may hold at most ${MAX_LOGIN_CREDENTIALS_PER_USER} login credentials.`,
    );
    this.name = "LoginCredentialLimitError";
  }
}

function credentialFromRow(row: LoginCredentialRow): LoginCredentialRecord {
  return {
    createdAtMs: Number(row.created_at_ms),
    expiresAtMs: row.expires_at_ms === null ? null : Number(row.expires_at_ms),
    id: row.id,
    lastUsedAtMs: row.last_used_at_ms === null
      ? null
      : Number(row.last_used_at_ms),
    name: row.name,
    revoked: Number(row.revoked) === 1,
    secret: row.secret,
    userId: row.user_id,
  };
}

export function normalizeLoginCredentialName(name: string): string {
  const normalized = name.trim();
  if (!normalized) {
    throw new TypeError("Enter a name for this login credential.");
  }
  if (normalized.length > 80) {
    throw new TypeError(
      "Login credential names must be 80 characters or fewer.",
    );
  }
  return normalized;
}

function generateLoginCredentialToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `${LOGIN_CREDENTIAL_PREFIX}${hex}`;
}

/** Count only live credentials, so revocation frees a slot immediately. */
export async function countLoginCredentialsForUser(
  database: D1Database,
  userId: string,
): Promise<number> {
  const row = await database.prepare(
    "SELECT COUNT(*) AS c FROM ext_login_credentials " +
      "WHERE user_id = ? AND revoked = 0",
  ).bind(userId).first<{c: number}>();
  return row?.c ?? 0;
}

export async function listLoginCredentialsForUser(
  database: D1Database,
  userId: string,
): Promise<LoginCredentialRecord[]> {
  const result = await database.prepare(
    "SELECT id, user_id, name, secret, created_at_ms, expires_at_ms, revoked, last_used_at_ms " +
      "FROM ext_login_credentials WHERE user_id = ? " +
      "ORDER BY created_at_ms DESC, id DESC",
  ).bind(userId).all<LoginCredentialRow>();
  return (result.results ?? []).map(credentialFromRow);
}

export async function findLoginCredential(
  database: D1Database,
  userId: string,
  id: string,
): Promise<LoginCredentialRecord | null> {
  const row = await database.prepare(
    "SELECT id, user_id, name, secret, created_at_ms, expires_at_ms, revoked, last_used_at_ms " +
      "FROM ext_login_credentials WHERE user_id = ? AND id = ? LIMIT 1",
  ).bind(userId, id).first<LoginCredentialRow>();
  return row ? credentialFromRow(row) : null;
}

export async function createLoginCredential(
  database: D1Database,
  input: {userId: string; name: string; expiresAtMs?: number | null},
  audit?: PendingAudit,
): Promise<LoginCredentialRecord> {
  const now = Date.now();
  const secret = generateLoginCredentialToken();
  const record: LoginCredentialRecord = {
    createdAtMs: now,
    expiresAtMs: input.expiresAtMs ?? null,
    id: crypto.randomUUID(),
    lastUsedAtMs: null,
    name: normalizeLoginCredentialName(input.name),
    revoked: false,
    secret,
    userId: input.userId,
  };
  // B14: the per-user cap is enforced inside the same transaction as the
  // insert — the old separate count-then-check had a window where two
  // concurrent creates both passed it and breached the cap together. The
  // credential row is only inserted while the count stays below the cap, and
  // the audit row — riding the same batch — only lands if the credential did.
  // The count takes live rows only (`revoked = 0`), exactly like
  // `countLoginCredentialsForUser`, so revoking frees a slot immediately.
  const results = await database.batch([
    database.prepare(
      "INSERT INTO ext_login_credentials " +
        "(id, user_id, name, secret, secret_hash, created_at_ms, expires_at_ms, revoked, last_used_at_ms) " +
        "SELECT ?, ?, ?, ?, ?, ?, ?, 0, NULL " +
        "WHERE (SELECT COUNT(*) FROM ext_login_credentials " +
        "WHERE user_id = ? AND revoked = 0) < ?",
    ).bind(
      record.id,
      record.userId,
      record.name,
      record.secret,
      await sha256Hex(record.secret),
      record.createdAtMs,
      record.expiresAtMs,
      record.userId,
      MAX_LOGIN_CREDENTIALS_PER_USER,
    ),
    ...(audit ? [auditStatement(database, audit, {
      sql: "SELECT 1 FROM ext_login_credentials WHERE id = ?",
      binds: [record.id],
    })] : []),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    throw new LoginCredentialLimitError();
  }
  return record;
}

/** 账号登录凭证的命名前缀（与 app-auth 历史一致）。 */
const APP_LOGIN_CREDENTIAL_PREFIX = "app-login:";

/** 共享的 auth_user 行形状（登录凭证签发需要 id / email / username）。 */
export interface AuthUserRow {
  email: string;
  id: string;
  name: string;
  username: string | null;
  image?: string | null;
}

/** App 登录凭证的稳定名（≤80，`normalizeLoginCredentialName` 上限）。 */
function appLoginCredentialName(user: AuthUserRow): string {
  return `${APP_LOGIN_CREDENTIAL_PREFIX}${user.username ?? user.email}`.slice(0, 80);
}

/**
 * 复用该账号尚未撤销的 App 登录凭证；没有则签发一把。
 * 触顶（该用户已有 5 把未撤销凭证）时返回 null，由调用方给出可读文案。
 * 抽出到登录凭证模块，供账号登录（app-auth）与第三方登录（app-third-party）共用
 * （ADR-0013，见 AndroidProject-old 仓 docs/adr/0013-qq-third-party-login.md）。
 */
export async function ensureAppLoginCredential(
  database: D1Database,
  user: AuthUserRow,
): Promise<LoginCredentialRecord | null> {
  const name = appLoginCredentialName(user);
  const existing = (await listLoginCredentialsForUser(database, user.id))
    .find((record) => !record.revoked && record.name === name);
  if (existing) return existing;
  try {
    return await createLoginCredential(database, {userId: user.id, name});
  } catch (error) {
    if (error instanceof LoginCredentialLimitError) return null;
    throw error;
  }
}

export async function revokeLoginCredential(
  database: D1Database,
  userId: string,
  id: string,
  audit?: PendingAudit,
): Promise<boolean> {
  const existing = await findLoginCredential(database, userId, id);
  if (!existing) return false;
  // The revocation and the audit row ride the same batch.
  await database.batch([
    database.prepare(
      "UPDATE ext_login_credentials SET revoked = 1 WHERE id = ? AND user_id = ?",
    ).bind(id, userId),
    ...(audit ? [auditStatement(database, audit)] : []),
  ]);
  return true;
}

export interface VerifiedLoginCredential {
  /** 账号缺失或 `auth_user.banned = 1`；调用方按未授权处理。 */
  banned: boolean;
  credentialId: string;
  userId: string;
}

export interface LoginCredentialLookupRow {
  account_id: string | null;
  banned: number | null;
  expires_at_ms: number | null;
  id: string;
  revoked: number | null;
  user_id: string;
}

/**
 * 凭证校验语句，供 middleware 批次一与限流桶同批执行（方案 6）。
 *
 * 封禁标记与凭证同一趟取回（LEFT JOIN `auth_user` 主键）：原来 `accountIsBlocked`
 * 再查一次，每次凭证调用多一趟往返。`auth_user` 缺行（凭证指向已删账号）与
 * `banned = 1` 同为封禁——`accountIsBlocked` 对缺行也是这么判的。
 * 走 `ext_login_credentials_secret_hash` 索引，`auth_user` 按主键最多 1 行。
 * 非 `mflc_` 前缀返回 null：不是本模块的凭证，不必查库。
 */
export async function loginCredentialVerifyStatement(
  database: D1Database,
  token: string,
): Promise<D1PreparedStatement | null> {
  const trimmed = token.trim();
  if (!trimmed.startsWith(LOGIN_CREDENTIAL_PREFIX)) return null;
  return database.prepare(
    "SELECT c.id, c.user_id, c.revoked, c.expires_at_ms, u.id AS account_id, u.banned " +
      "FROM ext_login_credentials c LEFT JOIN auth_user u ON u.id = c.user_id " +
      "WHERE c.secret_hash = ? LIMIT 1",
  ).bind(await sha256Hex(trimmed));
}

/** 行判定：未知、已撤销、已过期都返回 null。 */
export function verifiedLoginCredentialFromRow(
  row: LoginCredentialLookupRow | null | undefined,
  now = Date.now(),
): VerifiedLoginCredential | null {
  if (!row) return null;
  if (Number(row.revoked) === 1) return null;
  if (row.expires_at_ms !== null && Number(row.expires_at_ms) <= now) {
    return null;
  }
  return {
    banned: row.account_id === null || Number(row.banned) === 1,
    credentialId: row.id,
    userId: row.user_id,
  };
}

/**
 * Resolve a presented token to its owner. Returns `null` for a token that is
 * unknown, revoked, or past its expiry. Usage is *not* recorded here — see
 * {@link markLoginCredentialUsed}.
 */
export async function verifyLoginCredentialToken(
  database: D1Database,
  token: string,
): Promise<VerifiedLoginCredential | null> {
  const statement = await loginCredentialVerifyStatement(database, token);
  if (!statement) return null;
  return verifiedLoginCredentialFromRow(
    await statement.first<LoginCredentialLookupRow>(),
  );
}

/**
 * Record that a credential was used. Called by the callers once the request it
 * authenticated has been authorized, so a rejected call does not refresh the
 * dashboard's "last used" column.
 *
 * 写节流（ADR-0049 D4）：本函数在每个已授权请求上跑，无条件 UPDATE 会让满额
 * 凭证一天烧 1 万行写。改条件更新——只有距上次记录超过 60s 才写（≤1,440
 * 写/日/凭证）；仪表盘的「最近使用」粒度是分钟级展示，60s 抖动不可见。
 */
export const LAST_USED_THROTTLE_MS = 60_000;

export async function markLoginCredentialUsed(
  database: D1Database,
  credentialId: string,
): Promise<void> {
  const now = Date.now();
  await database.prepare(
    "UPDATE ext_login_credentials SET last_used_at_ms = ? " +
      "WHERE id = ? AND (last_used_at_ms IS NULL OR last_used_at_ms < ?)",
  ).bind(now, credentialId, now - LAST_USED_THROTTLE_MS).run();
}
