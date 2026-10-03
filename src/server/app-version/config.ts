/**
 * App version configuration + rollout rules (spec §6.2).
 *
 * Two tables back the `/admin/app-versions/` control plane:
 *  - `ext_app_version` — a single global row (`id = 1`): the latest release and
 *    the global `min_version_code` floor.
 *  - `ext_app_rollout` — grayscale rules (`all` / `user` / `device` / `percent`)
 *    layered on top of that floor (see `./resolve.ts`).
 *
 * Both are read by the public `GET /api/app/version` endpoint and by the version
 * gate `requireAppVersion`; this module is the only writer.
 *
 * Writes validate before touching the database and return a discriminated result
 * instead of throwing, so the AJAX layer can answer 400 without a try/catch.
 */

import {
  APP_ROLLOUT_SCOPES,
  DEFAULT_APP_VERSION_CONFIG,
  type AppRolloutRule,
  type AppRolloutScope,
  type AppVersionConfig,
} from "@/shared/AppDeviceVersion";

export type ConfigWriteResult =
  | {ok: true}
  | {ok: false; reason: "invalidConfig" | "invalidRule"};

interface AppVersionRow {
  latestVersionCode: number;
  latestVersionName: string;
  minVersionCode: number;
  downloadUrl: string;
  md5: string | null;
  updateLog: string | null;
  updatedAt: string | null;
}

/**
 * Read the singleton configuration row. Falls back to
 * {@link DEFAULT_APP_VERSION_CONFIG} when the row is absent (e.g. a database
 * that has not run migration 0080 yet) rather than throwing — the gate treats a
 * missing config as `min_version_code = 0`, i.e. "do not force".
 */
export async function readAppVersionConfig(
  db: D1Database,
): Promise<AppVersionConfig> {
  const row = await db
    .prepare(
      `SELECT latest_version_code AS latestVersionCode,
              latest_version_name AS latestVersionName,
              min_version_code AS minVersionCode,
              download_url AS downloadUrl,
              file_md5 AS md5,
              update_log AS updateLog,
              updated_at AS updatedAt
       FROM ext_app_version WHERE id = 1`,
    )
    .first<AppVersionRow>();
  if (!row) return {...DEFAULT_APP_VERSION_CONFIG};
  return {
    downloadUrl: row.downloadUrl ?? "",
    latestVersionCode: Number(row.latestVersionCode) || 0,
    latestVersionName: row.latestVersionName ?? "",
    md5: row.md5 ?? "",
    minVersionCode: Number(row.minVersionCode) || 0,
    updateLog: row.updateLog ?? "",
    updatedAt: row.updatedAt ?? null,
  };
}

function nonNegativeInt(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * Update the singleton row (inserting it if a pre-0080 DB has none).
 *
 * Fields omitted from `payload` keep their stored value, so a caller can patch
 * one field (e.g. only raise `minVersionCode`) without resending the rest — a
 * partial payload must not silently fail validation and leave the old row in
 * place.
 */
export async function saveAppVersionConfig(
  db: D1Database,
  payload: Partial<AppVersionConfig>,
): Promise<ConfigWriteResult> {
  const current = await readAppVersionConfig(db);
  const latestVersionCode = payload.latestVersionCode === undefined
    ? current.latestVersionCode
    : nonNegativeInt(payload.latestVersionCode);
  const minVersionCode = payload.minVersionCode === undefined
    ? current.minVersionCode
    : nonNegativeInt(payload.minVersionCode);
  const latestVersionName = payload.latestVersionName === undefined
    ? current.latestVersionName
    : String(payload.latestVersionName ?? "").trim();
  const downloadUrl = payload.downloadUrl === undefined
    ? current.downloadUrl
    : String(payload.downloadUrl ?? "").trim();
  const md5 = payload.md5 === undefined
    ? current.md5
    : String(payload.md5 ?? "").trim();
  const updateLog = payload.updateLog === undefined
    ? current.updateLog
    : String(payload.updateLog ?? "").trim();
  if (latestVersionCode === null || minVersionCode === null || latestVersionName === "") {
    return {ok: false, reason: "invalidConfig"};
  }
  await db
    .prepare(
      `INSERT INTO ext_app_version
         (id, latest_version_code, latest_version_name, min_version_code,
          download_url, file_md5, update_log, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET
         latest_version_code = excluded.latest_version_code,
         latest_version_name = excluded.latest_version_name,
         min_version_code = excluded.min_version_code,
         download_url = excluded.download_url,
         file_md5 = excluded.file_md5,
         update_log = excluded.update_log,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(
      latestVersionCode,
      latestVersionName,
      minVersionCode,
      downloadUrl,
      md5 || null,
      updateLog || null,
    )
    .run();
  return {ok: true};
}

/** Validation set, derived from the shared scope list so the two cannot drift. */
const ROLLOUT_SCOPES: ReadonlySet<string> = new Set<string>(APP_ROLLOUT_SCOPES);

export async function readRolloutRules(db: D1Database): Promise<AppRolloutRule[]> {
  const rows = await db
    .prepare(
      `SELECT id, scope, target, min_version_code AS minVersionCode, force
       FROM ext_app_rollout ORDER BY scope, id`,
    )
    .all<{
      id: number;
      scope: string;
      target: string | null;
      minVersionCode: number;
      force: number;
    }>();
  return (rows.results ?? []).map((row) => ({
    force: Number(row.force) === 1,
    id: Number(row.id),
    minVersionCode: Number(row.minVersionCode) || 0,
    scope: (ROLLOUT_SCOPES.has(row.scope) ? row.scope : "all") as AppRolloutScope,
    target: row.target,
  }));
}

/** Replace the whole rule set atomically (the board edits it as one list). */
export async function saveRolloutRules(
  db: D1Database,
  rules: unknown,
): Promise<ConfigWriteResult> {
  if (!Array.isArray(rules)) return {ok: false, reason: "invalidRule"};
  const normalized: Array<{scope: AppRolloutScope; target: string | null; minVersionCode: number; force: number}> = [];
  for (const raw of rules) {
    if (typeof raw !== "object" || raw === null) return {ok: false, reason: "invalidRule"};
    const rule = raw as Record<string, unknown>;
    const scope = String(rule.scope ?? "");
    if (!ROLLOUT_SCOPES.has(scope)) return {ok: false, reason: "invalidRule"};
    const minVersionCode = nonNegativeInt(rule.minVersionCode);
    if (minVersionCode === null) return {ok: false, reason: "invalidRule"};
    let target: string | null = rule.target == null ? null : String(rule.target).trim();
    if (target === "") target = null;
    if (scope === "all") {
      target = null;
    } else if (scope === "percent") {
      const percent = nonNegativeInt(target);
      if (percent === null || percent > 100) return {ok: false, reason: "invalidRule"};
      target = String(percent);
    } else if (target === null) {
      return {ok: false, reason: "invalidRule"};
    }
    normalized.push({
      force: rule.force === false || rule.force === 0 ? 0 : 1,
      minVersionCode,
      scope: scope as AppRolloutScope,
      target,
    });
  }
  const statements = [db.prepare("DELETE FROM ext_app_rollout")];
  for (const rule of normalized) {
    statements.push(
      db
        .prepare(
          `INSERT INTO ext_app_rollout (scope, target, min_version_code, force)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(rule.scope, rule.target, rule.minVersionCode, rule.force),
    );
  }
  await db.batch(statements);
  return {ok: true};
}
