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
 * 读取单行配置。
 *
 * 该行由迁移 0080 播种，因此**行缺失或字段非法一律直接抛出**（AGENTS.md 行为：就地崩溃，
 * 不静默兜底）。表不存在时 SQL 本身就会抛；行缺失说明迁移被改过或被手工删过，
 * 此时回落默认值会让「未配置」与「配置坏了」长得一模一样，排查时无从下手。
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
  if (!row) {
    throw new Error("ext_app_version 缺少 id=1 的配置行（迁移 0080 应已播种）");
  }
  return {
    // 可空列用 ?? "" 是列契约本身允许 null，不属于错误兜底。
    downloadUrl: row.downloadUrl ?? "",
    latestVersionCode: requiredNonNegativeInt(row.latestVersionCode, "ext_app_version.latest_version_code"),
    latestVersionName: row.latestVersionName ?? "",
    md5: row.md5 ?? "",
    minVersionCode: requiredNonNegativeInt(row.minVersionCode, "ext_app_version.min_version_code"),
    updateLog: row.updateLog ?? "",
    updatedAt: row.updatedAt ?? null,
  };
}

/** 整数字段必须是非负整数；`|| 0` 会把 NaN 悄悄变成 0，把配置损坏伪装成「没配置」。 */
function requiredNonNegativeInt(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} 不是合法的非负整数：${String(value)}`);
  }
  return parsed;
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
  return (rows.results ?? []).map((row) => {
    if (!ROLLOUT_SCOPES.has(row.scope)) {
      // 未知 scope 必须报错：静默当成 `all` 会让这条规则匹配**所有**设备（放大力度），
      // 静默丢掉则规则形同不存在——两者都比报错危险（AGENTS.md 行为：不静默兜底）。
      throw new Error(`未知的灰度 scope：${row.scope}`);
    }
    return {
      force: Number(row.force) === 1,
      id: Number(row.id),
      minVersionCode: requiredNonNegativeInt(row.minVersionCode, "ext_app_rollout.min_version_code"),
      scope: row.scope as AppRolloutScope,
      target: row.target,
    };
  });
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
    const force = rule.force;
    if (force !== true && force !== false && force !== 0 && force !== 1) {
      // force 必须显式给。缺省成 1（硬阻）意味着：前端或脚本一次漏字段，就能把真实用户
      // 全部 426 —— 后果落在用户身上、原因却在校验之外，宁可拒收（AGENTS.md 行为：不静默兜底）。
      return {ok: false, reason: "invalidRule"};
    }
    normalized.push({
      force: force === true || force === 1 ? 1 : 0,
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
