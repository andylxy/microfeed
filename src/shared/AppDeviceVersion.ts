/**
 * Shared DTOs for the device-management + app-version feature.
 *
 * These shapes cross the server/client boundary — the AJAX handlers serialise
 * them and the admin React components deserialise them — so they live in
 * `src/shared/` (the runtime-neutral layer both sides may import) instead of
 * being declared twice and drifting apart (AGENTS.md「源码架构」).
 *
 * Runtime-neutral on purpose: no D1, no `cloudflare:workers`, no DOM.
 */

/** One row of the cross-account device board (`/admin/devices/`). */
export interface AdminDeviceRow {
  deviceId: string;
  userId: string;
  username: string | null;
  email: string | null;
  status: string;
  lastSeenAt: string | null;
  createdAt: string | null;
}

/** The singleton app-version configuration row (`ext_app_version`, `id = 1`). */
export interface AppVersionConfig {
  latestVersionCode: number;
  latestVersionName: string;
  minVersionCode: number;
  downloadUrl: string;
  md5: string;
  updateLog: string;
  updatedAt: string | null;
}

/**
 * Sensible defaults for the singleton row: what the server returns when the row
 * is missing (fresh, unmigrated DB) and what the admin board starts from. Shared
 * so the two cannot drift.
 */
export const DEFAULT_APP_VERSION_CONFIG: AppVersionConfig = {
  downloadUrl: "",
  latestVersionCode: 0,
  latestVersionName: "",
  md5: "",
  minVersionCode: 0,
  updateLog: "",
  updatedAt: null,
};

/**
 * The grayscale rollout scopes (`ext_app_rollout.scope`). Single source of truth
 * for the server's validation set and the admin board's label lookup.
 */
export const APP_ROLLOUT_SCOPES = ["all", "user", "device", "percent"] as const;

export type AppRolloutScope = (typeof APP_ROLLOUT_SCOPES)[number];

/** One grayscale rule (`ext_app_rollout`). */
export interface AppRolloutRule {
  id: number;
  scope: AppRolloutScope;
  target: string | null;
  minVersionCode: number;
  force: boolean;
}

/**
 * Body of `POST /ajax/app-versions/save`: either half may be omitted, so the
 * board can save the config form and the rollout table independently.
 */
export interface AppVersionSavePayload {
  config?: Partial<AppVersionConfig>;
  rules?: Array<Partial<AppRolloutRule>>;
}
