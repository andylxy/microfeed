export interface ApiAccessSettings {
  enabled: boolean;
  publicDocsEnabled: boolean;
}

/**
 * Scopes of a legacy bearer API key.
 *
 * These govern the original `Authorization: Bearer <api_key>` path only. The
 * newer signed-call and login-credential paths authorise through RBAC instead
 * (`api:*` permission codes — see `src/server/api/api-permissions.ts`) and never
 * read this list, so a key's scopes say nothing about what those paths allow.
 * Unifying the two is an open decision, not a settled one.
 */
export const API_KEY_SCOPES = ["content:read", "content:write"] as const;
export type ApiKeyScope = typeof API_KEY_SCOPES[number];

export interface ApiKeyRecord {
  apiKey: string;
  /** Plaintext secret, present only on the response of create/rotate (shown once). */
  secret?: string;
  createdAtMs: number;
  id: string;
  name: string;
  scopes: ApiKeyScope[];
  updatedAtMs: number;
}

/** Max credentials a single user may own (matches XiHan BasicApp's per-user cap). */
export const MAX_API_CREDENTIALS_PER_USER = 5;

export function updateApiAccessEnabled(
  settings: ApiAccessSettings,
  enabled: boolean,
): ApiAccessSettings {
  return {
    ...settings,
    enabled,
    publicDocsEnabled: enabled ? settings.publicDocsEnabled : false,
  };
}

export function resolveApiAccessSettings(value: unknown): ApiAccessSettings {
  const settings = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const enabled = settings.enabled === true;
  return {
    enabled,
    publicDocsEnabled: typeof settings.publicDocsEnabled === "boolean"
      ? settings.publicDocsEnabled
      : enabled,
  };
}
