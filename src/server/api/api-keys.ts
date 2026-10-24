import {SETTINGS_CATEGORIES} from "@/shared/Constants";
import {sha256Hex} from "@/shared/crypto";
import {
  API_KEY_SCOPES,
  resolveApiAccessSettings,
  type ApiAccessSettings,
  type ApiKeyRecord,
  type ApiKeyScope,
  updateApiAccessEnabled,
} from "@/shared/Api";

interface ApiKeyRow {
  api_key_hint: string | null;
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
  // 明文不再入库（ADR-0047 D3）：列表行只有 hint；apiKey 仅在创建/轮换响应
  // 里由调用方补上。
  return {
    apiKeyHint: row.api_key_hint ?? "",
    createdAtMs: Number(row.created_at_ms),
    id: row.id,
    name: row.name,
    scopes: normalizeApiKeyScopes(row.scopes),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

/** 哈希与列表识别提示：与 mflc_ 凭证同一哈希口径（sha256Hex，无盐）。 */
async function apiKeyHashAndHint(
  plaintext: string,
): Promise<{hash: string; hint: string}> {
  return {hash: await sha256Hex(plaintext), hint: plaintext.slice(-4)};
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
): D1PreparedStatement {
  // 明文不再入库后无法按 token 值比对，legacy `$.apps` 残留按 id 清理
  // （0006 迁移把 token 与 id 一并带进了 api_keys）。
  return database.prepare(
    "UPDATE settings SET data = CASE " +
      "WHEN json_valid(data) AND json_type(data, '$.apps') = 'array' THEN " +
      "json_set(data, '$.apps', json(COALESCE((" +
      "SELECT json_group_array(json(value)) FROM json_each(data, '$.apps') " +
      "WHERE COALESCE(json_extract(value, '$.id'), '') != ?" +
      "), '[]'))) ELSE data END, updated_at = ? " +
      "WHERE category = ?",
  ).bind(
    id,
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
    "SELECT id, name, api_key_hint, scopes, created_at_ms, updated_at_ms " +
      "FROM api_keys ORDER BY created_at_ms DESC, id DESC",
  ).all<ApiKeyRow>();
  return result.results.map(apiKeyFromRow);
}

export async function findApiKey(
  database: D1Database,
  id: string,
): Promise<ApiKeyRecord | null> {
  const row = await database.prepare(
    "SELECT id, name, api_key_hint, scopes, created_at_ms, updated_at_ms " +
      "FROM api_keys WHERE id = ? LIMIT 1",
  ).bind(id).first<ApiKeyRow>();
  return row ? apiKeyFromRow(row) : null;
}

/**
 * 按明文经哈希查 key 行（ADR-0047 D3）：存在性 / scope 判定 / 审计归属三个
 * 入口共用这一处查表形状，均为 `sha256Hex(明文)` 等值查 `secret_hash`。
 * scopes 已归一化为 Set——调用方（含 access.ts 的合并判定，ADR-0049 D6）
 * 不必再各自解析。
 */
export async function lookupApiKeyBySecret(
  database: D1Database,
  providedApiKey: string,
): Promise<{id: string; scopes: Set<ApiKeyScope>} | null> {
  if (!providedApiKey) return null;
  const row = await database.prepare(
    "SELECT id, scopes FROM api_keys WHERE secret_hash = ? LIMIT 1",
  ).bind(await sha256Hex(providedApiKey)).first<{id: string; scopes: string}>();
  return row
    ? {id: row.id, scopes: new Set(normalizeApiKeyScopes(row.scopes))}
    : null;
}

export async function apiKeyExists(
  database: D1Database,
  providedApiKey: string,
): Promise<boolean> {
  return (await lookupApiKeyBySecret(database, providedApiKey)) !== null;
}

export async function createApiKey(
  database: D1Database,
  input: {
    name: string;
    scopes?: ApiKeyScope[];
    settings?: ApiAccessSettings;
  },
): Promise<ApiKeyRecord> {
  const now = Date.now();
  const plaintext = generateApiKey();
  const {hash, hint} = await apiKeyHashAndHint(plaintext);
  const apiKey: ApiKeyRecord = {
    // 完整明文只随创建响应返回一次（ADR-0047 D3）。
    apiKey: plaintext,
    apiKeyHint: hint,
    createdAtMs: now,
    id: crypto.randomUUID(),
    name: normalizeApiKeyName(input.name),
    scopes: normalizeApiKeyScopes(input.scopes),
    updatedAtMs: now,
  };
  const statements = [
    ...(input.settings
      ? [upsertApiSettingsStatement(
        database,
        updateApiAccessEnabled(input.settings, input.settings.enabled),
      )]
      : []),
    database.prepare(
      "INSERT INTO api_keys " +
        "(id, name, secret_hash, api_key_hint, scopes, created_at_ms, updated_at_ms) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      apiKey.id,
      apiKey.name,
      hash,
      hint,
      apiKey.scopes.join(" "),
      apiKey.createdAtMs,
      apiKey.updatedAtMs,
    ),
  ];
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
  const plaintext = generateApiKey();
  const {hash, hint} = await apiKeyHashAndHint(plaintext);
  await database.batch([
    database.prepare(
      "UPDATE api_keys SET secret_hash = ?, api_key_hint = ?, updated_at_ms = ? " +
        "WHERE id = ?",
    ).bind(hash, hint, now, id),
    removeLegacyApiKeyStatement(database, id),
  ]);
  const updated = await findApiKey(database, id);
  // 轮换响应同样只此一次携带完整明文。
  return updated ? {...updated, apiKey: plaintext} : null;
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
    // C2: migration 0032 leaves owner-row deletion to application code (no
    // ON DELETE CASCADE). Nothing writes ext_api_key_owners today, but this
    // keeps the revoke contract true if a writer ever lands — no orphan rows.
    database.prepare("DELETE FROM ext_api_key_owners WHERE api_key_id = ?").bind(id),
    removeLegacyApiKeyStatement(database, id),
  ]);
  return true;
}
