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
  credentialId: string;
  userId: string;
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
  const trimmed = token.trim();
  if (!trimmed.startsWith(LOGIN_CREDENTIAL_PREFIX)) return null;
  const row = await database.prepare(
    "SELECT id, user_id, revoked, expires_at_ms FROM ext_login_credentials " +
      "WHERE secret_hash = ? LIMIT 1",
  ).bind(await sha256Hex(trimmed)).first<{
    expires_at_ms: number | null;
    id: string;
    revoked: number | null;
    user_id: string;
  }>();
  if (!row) return null;
  if (Number(row.revoked) === 1) return null;
  if (row.expires_at_ms !== null && Number(row.expires_at_ms) <= Date.now()) {
    return null;
  }
  return {credentialId: row.id, userId: row.user_id};
}

/**
 * Record that a credential was used. Called by the callers once the request it
 * authenticated has been authorized, so a rejected call does not refresh the
 * dashboard's "last used" column.
 */
export async function markLoginCredentialUsed(
  database: D1Database,
  credentialId: string,
): Promise<void> {
  await database.prepare(
    "UPDATE ext_login_credentials SET last_used_at_ms = ? WHERE id = ?",
  ).bind(Date.now(), credentialId).run();
}
