export interface ApiAccessSettings {
  enabled: boolean;
  publicDocsEnabled: boolean;
}

/**
 * Scopes of a legacy bearer API key — the upstream OAuth-scope model, kept as
 * upstream ships it. The login-credential bearer path never reads these: it
 * authorises through RBAC instead (ADR-0009).
 */
export const API_KEY_SCOPES = ["content:read", "content:write"] as const;
export type ApiKeyScope = typeof API_KEY_SCOPES[number];

export interface ApiKeyRecord {
  apiKey: string;
  createdAtMs: number;
  id: string;
  name: string;
  scopes: ApiKeyScope[];
  updatedAtMs: number;
}

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
