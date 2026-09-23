import {SETTINGS_CATEGORIES} from "@/shared/Constants";
import {sha256Hex} from "@/shared/crypto";
import {
  API_KEY_SCOPES,
  MAX_API_CREDENTIALS_PER_USER,
  resolveApiAccessSettings,
  type ApiAccessSettings,
  type ApiKeyRecord,
  type ApiKeyScope,
  updateApiAccessEnabled,
} from "@/shared/Api";

interface ApiKeyRow {
  api_key: string;
  created_at_ms: number;
  id: string;
  name: string;
  scopes: string;
  updated_at_ms: number;
}

interface ApiSettingsRow {
  data: string;
}

export class ApiKeyNameConflictError extends Error {
  constructor() {
    super("An API key with this name already exists.");
    this.name = "ApiKeyNameConflictError";
  }
}

function apiKeyFromRow(row: ApiKeyRow): ApiKeyRecord {
  return {
    apiKey: row.api_key,
    createdAtMs: Number(row.created_at_ms),
    id: row.id,
    name: row.name,
    scopes: normalizeApiKeyScopes(row.scopes),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function normalizeApiKeyScopes(scopes: unknown): ApiKeyScope[] {
  const values = Array.isArray(scopes)
    ? scopes
    : typeof scopes === "string"
    ? scopes.split(/\s+/u)
    : [];
  const normalized = [...new Set(values)].filter((scope): scope is ApiKeyScope =>
    typeof scope === "string" &&
    (API_KEY_SCOPES as readonly string[]).includes(scope)
  );
  return normalized.length ? normalized : [...API_KEY_SCOPES];
}

function normalizeApiKeyName(name: string): string {
  const normalized = name.trim();
  if (!normalized) {
    throw new TypeError("Enter a name for this API key.");
  }
  if (normalized.length > 80) {
    throw new TypeError("API key names must be 80 characters or fewer.");
  }
  return normalized;
}

function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const secret = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `mf_${secret}`;
}

/** Plaintext secret shown to the client exactly once (e.g. on issue / rotation). */
function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `mfsk_${hex}`;
}

/** The HMAC key is the SHA-256 of the secret; the server stores only this hash. */
async function hashSecret(secret: string): Promise<string> {
  return sha256Hex(secret);
}

function boolJson(value: boolean): string {
  return value ? "true" : "false";
}

function upsertApiSettingsStatement(
  database: D1Database,
  settings: ApiAccessSettings,
): D1PreparedStatement {
  const timestamp = new Date().toISOString();
  return database.prepare(
    "INSERT INTO settings (category, data, created_at, updated_at) " +
      "VALUES (?, json_object(" +
      "'enabled', json(?), 'publicDocsEnabled', json(?)), ?, ?) " +
      "ON CONFLICT(category) DO UPDATE SET " +
      "data = json_set(" +
      "CASE WHEN json_valid(settings.data) THEN settings.data ELSE '{}' END, " +
      "'$.enabled', json(?), '$.publicDocsEnabled', json(?)), " +
      "updated_at = ?",
  ).bind(
    SETTINGS_CATEGORIES.API_SETTINGS,
    boolJson(settings.enabled),
    boolJson(settings.publicDocsEnabled),
    timestamp,
    timestamp,
    boolJson(settings.enabled),
    boolJson(settings.publicDocsEnabled),
    timestamp,
  );
}

function removeLegacyApiKeyStatement(
  database: D1Database,
  id: string,
  apiKey: string,
): D1PreparedStatement {
  return database.prepare(
    "UPDATE settings SET data = CASE " +
      "WHEN json_valid(data) AND json_type(data, '$.apps') = 'array' THEN " +
      "json_set(data, '$.apps', json(COALESCE((" +
      "SELECT json_group_array(json(value)) FROM json_each(data, '$.apps') " +
      "WHERE COALESCE(json_extract(value, '$.id'), '') != ? " +
      "AND COALESCE(json_extract(value, '$.token'), '') != ?" +
      "), '[]'))) ELSE data END, updated_at = ? " +
      "WHERE category = ?",
  ).bind(
    id,
    apiKey,
    new Date().toISOString(),
    SETTINGS_CATEGORIES.API_SETTINGS,
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique constraint/iu.test(error.message);
}

export async function readApiAccessSettings(
  database: D1Database,
): Promise<ApiAccessSettings> {
  const row = await database.prepare(
    "SELECT data FROM settings WHERE category = ? LIMIT 1",
  ).bind(SETTINGS_CATEGORIES.API_SETTINGS).first<ApiSettingsRow>();
  if (!row) {
    return resolveApiAccessSettings(undefined);
  }
  try {
    return resolveApiAccessSettings(JSON.parse(row.data));
  } catch {
    return resolveApiAccessSettings(undefined);
  }
}

export async function updateApiAccessSettings(
  database: D1Database,
  settings: ApiAccessSettings,
): Promise<ApiAccessSettings> {
  const normalized = updateApiAccessEnabled(settings, settings.enabled);
  await upsertApiSettingsStatement(database, normalized).run();
  return normalized;
}

export async function listApiKeys(
  database: D1Database,
): Promise<ApiKeyRecord[]> {
  const result = await database.prepare(
    "SELECT id, name, api_key, scopes, created_at_ms, updated_at_ms " +
      "FROM api_keys ORDER BY created_at_ms DESC, id DESC",
  ).all<ApiKeyRow>();
  return result.results.map(apiKeyFromRow);
}

export async function findApiKey(
  database: D1Database,
  id: string,
): Promise<ApiKeyRecord | null> {
  const row = await database.prepare(
    "SELECT id, name, api_key, scopes, created_at_ms, updated_at_ms " +
      "FROM api_keys WHERE id = ? LIMIT 1",
  ).bind(id).first<ApiKeyRow>();
  return row ? apiKeyFromRow(row) : null;
}

export async function apiKeyExists(
  database: D1Database,
  providedApiKey: string,
): Promise<boolean> {
  if (!providedApiKey) {
    return false;
  }
  const row = await database.prepare(
    "SELECT 1 AS found FROM api_keys WHERE api_key = ? LIMIT 1",
  ).bind(providedApiKey).first<{found: number}>();
  return row?.found === 1;
}

export async function apiKeyScopes(
  database: D1Database,
  providedApiKey: string,
): Promise<Set<ApiKeyScope> | null> {
  if (!providedApiKey) return null;
  const row = await database.prepare(
    "SELECT scopes FROM api_keys WHERE api_key = ? LIMIT 1",
  ).bind(providedApiKey).first<{scopes: string}>();
  return row ? new Set(normalizeApiKeyScopes(row.scopes)) : null;
}

export async function createApiKey(
  database: D1Database,
  input: {
    name: string;
    scopes?: ApiKeyScope[];
    settings?: ApiAccessSettings;
    ownerUserId?: string;
  },
): Promise<ApiKeyRecord> {
  const now = Date.now();
  const normalizedName = normalizeApiKeyName(input.name);
  const scopes = normalizeApiKeyScopes(input.scopes);
  const id = crypto.randomUUID();
  const apiKeyValue = generateApiKey();
  // A user-owned credential gets a secret so it can sign requests; an admin
  // (global) key stays bearer-only and has no secret.
  const secret = input.ownerUserId ? generateSecret() : undefined;
  const secretHash = secret ? await hashSecret(secret) : undefined;
  const apiKey: ApiKeyRecord = {
    apiKey: apiKeyValue,
    createdAtMs: now,
    id,
    name: normalizedName,
    scopes,
    secret,
    updatedAtMs: now,
  };
  const statements: D1PreparedStatement[] = [
    ...(input.settings
      ? [upsertApiSettingsStatement(
        database,
        updateApiAccessEnabled(input.settings, input.settings.enabled),
      )]
      : []),
    database.prepare(
      "INSERT INTO api_keys " +
        "(id, name, api_key, scopes, secret_hash, created_at_ms, updated_at_ms) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      apiKey.id,
      apiKey.name,
      apiKey.apiKey,
      apiKey.scopes.join(" "),
      secretHash ?? null,
      apiKey.createdAtMs,
      apiKey.updatedAtMs,
    ),
  ];
  if (input.ownerUserId) {
    statements.push(
      database.prepare(
        "INSERT INTO ext_api_key_owners (api_key_id, user_id, created_at_ms) " +
          "VALUES (?, ?, ?)",
      ).bind(apiKey.id, input.ownerUserId, now),
    );
  }
  try {
    await database.batch(statements);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new ApiKeyNameConflictError();
    }
    throw error;
  }
  return apiKey;
}

export async function renameApiKey(
  database: D1Database,
  id: string,
  name: string,
): Promise<ApiKeyRecord | null> {
  const normalizedName = normalizeApiKeyName(name);
  try {
    await database.prepare(
      "UPDATE api_keys SET name = ?, updated_at_ms = ? WHERE id = ?",
    ).bind(normalizedName, Date.now(), id).run();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new ApiKeyNameConflictError();
    }
    throw error;
  }
  return findApiKey(database, id);
}

export async function rotateApiKey(
  database: D1Database,
  id: string,
): Promise<ApiKeyRecord | null> {
  const existing = await findApiKey(database, id);
  if (!existing) {
    return null;
  }
  const now = Date.now();
  await database.batch([
    database.prepare(
      "UPDATE api_keys SET api_key = ?, updated_at_ms = ? WHERE id = ?",
    ).bind(generateApiKey(), now, id),
    removeLegacyApiKeyStatement(database, id, existing.apiKey),
  ]);
  return findApiKey(database, id);
}

export async function revokeApiKey(
  database: D1Database,
  id: string,
): Promise<boolean> {
  const existing = await findApiKey(database, id);
  if (!existing) {
    return false;
  }
  await database.batch([
    database.prepare("DELETE FROM api_keys WHERE id = ?").bind(id),
    removeLegacyApiKeyStatement(database, id, existing.apiKey),
  ]);
  return true;
}

// ---------------------------------------------------------------------------
// User-scoped credentials (signed-call). Every key created here is owned by the
// calling user, so a signed request can be attributed to both the key and the
// user. Admin-issued global keys (createApiKey without ownerUserId) are a
// separate, bearer-only path and are intentionally not returned here.
// ---------------------------------------------------------------------------

export async function countApiKeysForUser(
  database: D1Database,
  userId: string,
): Promise<number> {
  const row = await database.prepare(
    "SELECT COUNT(*) AS c FROM ext_api_key_owners WHERE user_id = ?",
  ).bind(userId).first<{c: number}>();
  return row?.c ?? 0;
}

export async function listApiKeysForUser(
  database: D1Database,
  userId: string,
): Promise<ApiKeyRecord[]> {
  const result = await database.prepare(
    "SELECT k.id, k.name, k.api_key, k.scopes, k.created_at_ms, k.updated_at_ms " +
      "FROM api_keys k JOIN ext_api_key_owners o ON o.api_key_id = k.id " +
      "WHERE o.user_id = ? ORDER BY k.created_at_ms DESC, k.id DESC",
  ).bind(userId).all<ApiKeyRow>();
  return (result.results ?? []).map(apiKeyFromRow);
}

export async function findApiKeyForUser(
  database: D1Database,
  userId: string,
  id: string,
): Promise<ApiKeyRecord | null> {
  const row = await database.prepare(
    "SELECT k.id, k.name, k.api_key, k.scopes, k.created_at_ms, k.updated_at_ms " +
      "FROM api_keys k JOIN ext_api_key_owners o ON o.api_key_id = k.id " +
      "WHERE o.user_id = ? AND k.id = ? LIMIT 1",
  ).bind(userId, id).first<ApiKeyRow>();
  return row ? apiKeyFromRow(row) : null;
}

export async function rotateApiKeyForUser(
  database: D1Database,
  userId: string,
  id: string,
): Promise<ApiKeyRecord | null> {
  const existing = await findApiKeyForUser(database, userId, id);
  if (!existing) return null;
  const secret = generateSecret();
  const secretHash = await hashSecret(secret);
  const now = Date.now();
  await database.batch([
    database.prepare(
      "UPDATE api_keys SET secret_hash = ?, updated_at_ms = ? WHERE id = ?",
    ).bind(secretHash, now, id),
    removeLegacyApiKeyStatement(database, id, existing.apiKey),
  ]);
  const rotated = await findApiKeyForUser(database, userId, id);
  if (rotated) rotated.secret = secret;
  return rotated;
}

export async function renameApiKeyForUser(
  database: D1Database,
  userId: string,
  id: string,
  name: string,
): Promise<ApiKeyRecord | null> {
  const normalizedName = normalizeApiKeyName(name);
  try {
    await database.prepare(
      "UPDATE api_keys SET name = ?, updated_at_ms = ? " +
        "WHERE id = ? AND id IN (" +
        "SELECT api_key_id FROM ext_api_key_owners WHERE user_id = ?)",
    ).bind(normalizedName, Date.now(), id, userId).run();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new ApiKeyNameConflictError();
    }
    throw error;
  }
  return findApiKeyForUser(database, userId, id);
}

export async function revokeApiKeyForUser(
  database: D1Database,
  userId: string,
  id: string,
): Promise<boolean> {
  const existing = await findApiKeyForUser(database, userId, id);
  if (!existing) return false;
  await database.batch([
    database.prepare("DELETE FROM ext_api_key_owners WHERE api_key_id = ?")
      .bind(id),
    database.prepare("DELETE FROM api_keys WHERE id = ?").bind(id),
    removeLegacyApiKeyStatement(database, id, existing.apiKey),
  ]);
  return true;
}

export {MAX_API_CREDENTIALS_PER_USER};
