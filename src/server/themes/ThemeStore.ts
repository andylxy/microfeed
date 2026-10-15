import semver from "semver";

import {
  PUBLIC_CACHE_TAGS,
  purgePublicCache,
  type PublicCachePurger,
} from "@/server/cache/public-cache";
import {MICROFEED_VERSION} from "@/shared/Version";
import {AppError} from "@/shared/errors";
import type {
  BuiltInThemeGroup,
  StoredThemeVersion,
  ThemeBundleV1,
  ThemeDraft,
  ThemeListOptions,
  ThemeListResponse,
  ThemeListSort,
  ThemeManifestV1,
  ThemePreviewFixture,
  ThemeAdminTab,
  PurgedThemeVersion,
  ThemeSourceKind,
  ThemeState,
  ThemeVersionSummary,
} from "@/shared/themes/ThemeContract";
import {
  assertUserThemePackageId,
  LOCAL_THEME_PACKAGE_ID_PREFIX,
  THEME_LIST_PAGE_SIZE,
  THEME_MAX_CUSTOM_INSTALLED_VERSIONS,
  THEME_MAX_DRAFTS,
  themePreviewFixtureSchema,
} from "@/shared/themes/ThemeContract";
import {
  BUNDLED_FALLBACK_THEME,
  BUNDLED_THEME_CATALOG,
  bundledThemeCatalogEntryByPackageId,
} from "@/shared/themes/BundledThemeCatalog";
import {
  canonicalThemePackage,
  sha256Hex,
} from "@/shared/themes/ThemeRenderer";
import {
  validateStoredThemePackage,
  validateThemePackage,
} from "@/shared/themes/ThemeValidation";
import {
  commitDatabaseMutation,
  type DatabaseMutationCommit,
} from "@/server/mutation";
import {
  storedThemeFromRow,
  storedThemeSummaryFromRow,
  themeDraftFromRow,
  themeDraftSummaryFromRow,
  themeStateFromRow,
} from "@/shared/themes/ThemeRows";
import {
  BUNDLED_DEFAULT_THEME_BUNDLE,
  BUNDLED_DEFAULT_THEME_ID,
  BUNDLED_DEFAULT_THEME_MANIFEST,
  BUNDLED_DEFAULT_THEME_PREVIEW_FIXTURE,
  legacyThemeMigrationSource,
  MIGRATED_LEGACY_THEME_ID,
} from "./BundledThemes";

interface ThemeSource {
  commit?: string | null;
  kind: ThemeSourceKind;
  path?: string | null;
  ref?: string | null;
  url?: string | null;
}

export interface InstallThemeInput {
  assetOwnerThemeId?: string | null;
  bundle: ThemeBundleV1;
  id?: string;
  manifest: ThemeManifestV1;
  originThemeId?: string | null;
  previewFixture?: ThemePreviewFixture | null;
  source: ThemeSource;
}

export interface CreateDraftInput {
  assetOwnerThemeId?: string | null;
  bundle: ThemeBundleV1;
  manifest: ThemeManifestV1;
  originKind: "built-in" | "theme";
  originThemeId?: string | null;
  previewFixture?: ThemePreviewFixture | null;
}

export interface SaveDraftInput {
  bundle: ThemeBundleV1;
  manifest: ThemeManifestV1;
}

function results<T extends Record<string, unknown>>(
  result: D1Result<unknown>,
): T[] {
  return (result.results ?? []) as T[];
}

function validatedPreviewFixture(
  manifest: ThemeManifestV1,
  fixture: unknown,
): ThemePreviewFixture | null {
  if (!manifest.previewFixture) {
    if (fixture !== null && fixture !== undefined) {
      throw new AppError("errors.theme.previewFixtureRequiresManifest");
    }
    return null;
  }
  if (fixture === null || fixture === undefined) {
    throw new AppError("errors.theme.previewFixtureMissing", 400, {
      fixture: manifest.previewFixture,
    });
  }
  return themePreviewFixtureSchema.parse(fixture);
}

function localPackageId(packageId: string): string {
  if (packageId.startsWith(LOCAL_THEME_PACKAGE_ID_PREFIX)) return packageId;
  return `${LOCAL_THEME_PACKAGE_ID_PREFIX}${packageId}`
    .slice(0, 120).replace(/[._-]+$/u, "");
}

function nextPatchVersion(versions: string[], sourceVersion: string): string {
  const valid = versions.filter((version) => semver.valid(version));
  const baseline = semver.valid(sourceVersion) ? sourceVersion : "0.0.0";
  const latest = valid.sort(semver.rcompare)[0] ?? baseline;
  return semver.inc(latest, "patch") ?? "0.0.1";
}

function escapedLike(value: string): string {
  return `%${value.toLocaleLowerCase().replace(/[\\%_]/gu, "\\$&")}%`;
}

const THEME_SUMMARY_COLUMNS = `
  themes.id, themes.package_id, themes.version, themes.name,
  themes.manifest_json, themes.source_kind, themes.source_url,
  themes.source_ref, themes.source_path, themes.source_commit,
  themes.checksum_sha256, themes.origin_theme_id,
  origin_themes.name AS origin_theme_name,
  origin_themes.version AS origin_theme_version,
  themes.asset_owner_theme_id, themes.created_at, themes.deleted_at,
  COALESCE(json_array_length(json_extract(themes.manifest_json, '$.assets')), 0)
    AS asset_count`;

const DRAFT_SUMMARY_COLUMNS = `
  id, package_id, version, name, manifest_json, origin_kind,
  origin_theme_id, asset_owner_theme_id, created_at, updated_at,
  COALESCE(json_array_length(json_extract(manifest_json, '$.assets')), 0)
    AS asset_count`;

function builtInThemeGroups(
  rows: Array<Record<string, unknown>>,
  state: ThemeState,
): BuiltInThemeGroup[] {
  const byPackage = new Map<string, ThemeVersionSummary[]>();
  for (const row of rows) {
    const summary = storedThemeSummaryFromRow(row);
    const versions = byPackage.get(summary.packageId) ?? [];
    versions.push(summary);
    byPackage.set(summary.packageId, versions);
  }
  const packageOrder = new Map(
    BUNDLED_THEME_CATALOG.map((entry) => [
      entry.packageId,
      entry.order,
    ]),
  );
  return [...byPackage].map(([packageId, versions]) => {
    const catalog = bundledThemeCatalogEntryByPackageId(packageId);
    versions.sort((left, right) => {
      const leftRank = left.version === catalog?.manifest.version
        ? 0
        : left.id === state.activeThemeId
        ? 1
        : left.id === state.previousThemeId
        ? 2
        : 3;
      const rightRank = right.version === catalog?.manifest.version
        ? 0
        : right.id === state.activeThemeId
        ? 1
        : right.id === state.previousThemeId
        ? 2
        : 3;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return semver.rcompare(
        semver.valid(left.version) ?? "0.0.0",
        semver.valid(right.version) ?? "0.0.0",
      ) || right.createdAt.localeCompare(left.createdAt) ||
        left.id.localeCompare(right.id);
    });
    return {
      catalogKey: catalog?.key ?? null,
      currentVersion: catalog?.manifest.version ?? null,
      packageId,
      source: catalog?.source ?? null,
      versions,
    };
  }).sort((left, right) => {
    const leftOrder = packageOrder.get(left.packageId) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = packageOrder.get(right.packageId) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.packageId.localeCompare(right.packageId);
  });
}

export default class ThemeStore {
  constructor(
    private readonly database: D1Database,
    private readonly publicCachePurger?: PublicCachePurger,
  ) {}

  private async purgeActiveTheme(): Promise<void> {
    if (this.publicCachePurger) {
      await purgePublicCache(
        [PUBLIC_CACHE_TAGS.THEME_CURRENT],
        this.publicCachePurger,
      );
    }
  }

  async listVersions(includeDeleted = true): Promise<StoredThemeVersion[]> {
    const result = await this.database.prepare(
      `SELECT * FROM themes
       ${includeDeleted ? "" : "WHERE deleted_at IS NULL"}
       ORDER BY package_id ASC, created_at DESC`,
    ).all();
    return results(result).map(storedThemeFromRow);
  }

  async listDrafts(): Promise<ThemeDraft[]> {
    const result = await this.database.prepare(
      "SELECT * FROM theme_drafts ORDER BY updated_at DESC",
    ).all();
    return results(result).map(themeDraftFromRow);
  }

  async listSummaries(
    options: ThemeListOptions,
    requestedScope: ThemeAdminTab | null = null,
  ): Promise<ThemeListResponse> {
    const page = Math.max(1, Math.trunc(options.page));
    const search = options.q ? escapedLike(options.q) : null;
    const where = search
      ? `WHERE themes.deleted_at IS NULL
        AND themes.source_kind != 'bundled' AND (
          lower(themes.name) LIKE ? ESCAPE '\\' OR
          lower(themes.package_id) LIKE ? ESCAPE '\\' OR
          lower(themes.version) LIKE ? ESCAPE '\\' OR
          lower(COALESCE(json_extract(themes.manifest_json, '$.author'), '')) LIKE ? ESCAPE '\\' OR
          lower(COALESCE(themes.source_url, '')) LIKE ? ESCAPE '\\'
        )`
      : "WHERE themes.deleted_at IS NULL AND themes.source_kind != 'bundled'";
    const sortSql = {
      "installed-asc": "themes.created_at ASC, themes.id ASC",
      "installed-desc": "themes.created_at DESC, themes.id ASC",
      "name-asc": "lower(themes.name) ASC, themes.version ASC, themes.id ASC",
      "name-desc": "lower(themes.name) DESC, themes.version DESC, themes.id ASC",
      status: `CASE
        WHEN themes.id = theme_state.active_theme_id THEN 0
        WHEN themes.id = theme_state.previous_theme_id THEN 1
        ELSE 2 END ASC, themes.created_at DESC, themes.id ASC`,
    } satisfies Record<ThemeListSort, string>;
    const parameters = search ? [search, search, search, search, search] : [];
    const [themeRows, countRow, customCountRow, builtInRows, draftRows, state] =
      await Promise.all([
      this.database.prepare(
        `SELECT ${THEME_SUMMARY_COLUMNS}
         FROM themes
         LEFT JOIN themes AS origin_themes
           ON origin_themes.id = themes.origin_theme_id
         CROSS JOIN theme_state
         ${where} AND theme_state.id = 'current'
         ORDER BY ${sortSql[options.sort]}
         LIMIT ? OFFSET ?`,
      ).bind(
        ...parameters,
        THEME_LIST_PAGE_SIZE,
        (page - 1) * THEME_LIST_PAGE_SIZE,
      ).all(),
      this.database.prepare(
        `SELECT count(*) AS total FROM themes ${where.replaceAll("themes.", "themes.")}`,
      ).bind(...parameters).first<{total: number}>(),
      this.database.prepare(
        `SELECT count(*) AS total FROM themes
         WHERE deleted_at IS NULL AND source_kind != 'bundled'`,
      ).first<{total: number}>(),
      this.database.prepare(
        `SELECT ${THEME_SUMMARY_COLUMNS}
         FROM themes
         LEFT JOIN themes AS origin_themes
           ON origin_themes.id = themes.origin_theme_id
         WHERE themes.deleted_at IS NULL AND themes.source_kind = 'bundled'
         ORDER BY themes.package_id ASC, themes.created_at DESC`,
      ).all(),
      this.database.prepare(
        `SELECT ${DRAFT_SUMMARY_COLUMNS}
         FROM theme_drafts ORDER BY updated_at DESC`,
      ).all(),
      this.getState(),
    ]);
    const total = Number(countRow?.total ?? 0);
    const builtInGroups = builtInThemeGroups(results(builtInRows), state);
    const activeIsBuiltIn = builtInGroups.some((group) =>
      group.versions.some(({id}) => id === state.activeThemeId)
    );
    return {
      builtInGroups,
      counts: {
        builtInThemes: builtInGroups.length,
        builtInVersions: builtInGroups.reduce(
          (sum, group) => sum + group.versions.length,
          0,
        ),
        customVersions: Number(customCountRow?.total ?? 0),
      },
      customThemes: results(themeRows).map(storedThemeSummaryFromRow),
      drafts: results(draftRows).map(themeDraftSummaryFromRow),
      limits: {
        customInstalled: THEME_MAX_CUSTOM_INSTALLED_VERSIONS,
        drafts: THEME_MAX_DRAFTS,
      },
      pagination: {
        page,
        pageSize: THEME_LIST_PAGE_SIZE,
        total,
        totalPages: Math.ceil(total / THEME_LIST_PAGE_SIZE),
      },
      scope: requestedScope ?? (
        state.activeThemeId && !activeIsBuiltIn ? "custom" : "built-in"
      ),
      state,
    };
  }

  async getVersion(id: string, includeDeleted = false): Promise<StoredThemeVersion | null> {
    const row = await this.database.prepare(
      `SELECT * FROM themes WHERE id = ?
       ${includeDeleted ? "" : "AND deleted_at IS NULL"} LIMIT 1`,
    ).bind(id).first<Record<string, unknown>>();
    return row ? storedThemeFromRow(row) : null;
  }

  async getDraft(id: string): Promise<ThemeDraft | null> {
    const row = await this.database.prepare(
      "SELECT * FROM theme_drafts WHERE id = ? LIMIT 1",
    ).bind(id).first<Record<string, unknown>>();
    return row ? themeDraftFromRow(row) : null;
  }

  async getState(): Promise<ThemeState> {
    const row = await this.database.prepare(
      "SELECT * FROM theme_state WHERE id = 'current' LIMIT 1",
    ).first<Record<string, unknown>>();
    return themeStateFromRow(row);
  }

  /**
   * Converts the selected pre-versioning custom theme exactly once. The
   * original settings.customCode value is deliberately never changed so an
   * older microfeed release can still use it after an application rollback.
   */
  async ensureLegacyThemeMigrated(
    settings: Record<string, any> | null | undefined,
  ): Promise<StoredThemeVersion | null> {
    const state = await this.database.prepare(
      `SELECT active_theme_id, legacy_migrated_at
       FROM theme_state WHERE id = 'current' LIMIT 1`,
    ).first<{active_theme_id: string | null; legacy_migrated_at: string | null}>();
    if (!state) throw new AppError("errors.theme.stateUnavailable");
    if (state.legacy_migrated_at) {
      return state.active_theme_id
        ? await this.getVersion(state.active_theme_id)
        : null;
    }

    const source = legacyThemeMigrationSource(settings);
    if (!source) {
      await this.database.prepare(
        `UPDATE theme_state SET legacy_migrated_at = CURRENT_TIMESTAMP,
         legacy_migration_error = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = 'current' AND legacy_migrated_at IS NULL`,
      ).run();
      return state.active_theme_id
        ? await this.getVersion(state.active_theme_id)
        : null;
    }

    let validated: {bundle: ThemeBundleV1; manifest: ThemeManifestV1};
    let checksum: string;
    try {
      validated = validateThemePackage(
        source.manifest,
        source.bundle,
        MICROFEED_VERSION,
      );
      checksum = await sha256Hex(canonicalThemePackage(
        validated.manifest,
        validated.bundle,
      ));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.database.prepare(
        `UPDATE theme_state SET legacy_migrated_at = CURRENT_TIMESTAMP,
         legacy_migration_error = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = 'current' AND legacy_migrated_at IS NULL`,
      ).bind(message).run();
      console.error(JSON.stringify({
        error: message,
        message: "Existing theme migration failed; using the bundled default or active D1 theme",
      }));
      return state.active_theme_id
        ? await this.getVersion(state.active_theme_id)
        : null;
    }

    await this.database.batch([
      this.database.prepare(
        `INSERT OR IGNORE INTO themes (
          id, package_id, version, name, manifest_json, bundle_json,
          source_kind, checksum_sha256, origin_theme_id, asset_owner_theme_id
        ) VALUES (?, ?, ?, ?, ?, ?, 'migration', ?, NULL, NULL)`,
      ).bind(
        MIGRATED_LEGACY_THEME_ID,
        validated.manifest.packageId,
        validated.manifest.version,
        validated.manifest.name,
        JSON.stringify(validated.manifest),
        JSON.stringify(validated.bundle),
        checksum,
      ),
      this.database.prepare(
        `UPDATE theme_state SET legacy_theme_id = ?,
         active_theme_id = COALESCE(active_theme_id, ?),
         legacy_migrated_at = CURRENT_TIMESTAMP,
         legacy_migration_error = NULL,
         updated_at = CURRENT_TIMESTAMP
         WHERE id = 'current' AND legacy_migrated_at IS NULL`,
      ).bind(MIGRATED_LEGACY_THEME_ID, MIGRATED_LEGACY_THEME_ID),
    ]);
    const migratedState = await this.getState();
    if (!state.active_theme_id && migratedState.activeThemeId === MIGRATED_LEGACY_THEME_ID) {
      await this.purgeActiveTheme();
    }
    return migratedState.activeThemeId
      ? await this.getVersion(migratedState.activeThemeId)
      : null;
  }

  /**
   * Gives an upgraded site with no selected version the same bundled default
   * used for pristine initialization. Existing active D1 themes are unchanged.
   */
  async ensureAppearancePreserved(): Promise<StoredThemeVersion | null> {
    const state = await this.database.prepare(
      `SELECT active_theme_id, appearance_preserved_at
       FROM theme_state WHERE id = 'current' LIMIT 1`,
    ).first<{
      active_theme_id: string | null;
      appearance_preserved_at: string | null;
    }>();
    if (!state) throw new AppError("errors.theme.stateUnavailable");
    if (state.appearance_preserved_at || state.active_theme_id) {
      if (!state.appearance_preserved_at) {
        await this.database.prepare(
          `UPDATE theme_state SET appearance_preserved_at = CURRENT_TIMESTAMP,
           appearance_preservation_error = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = 'current' AND appearance_preserved_at IS NULL`,
        ).run();
      }
      return state.active_theme_id
        ? await this.getVersion(state.active_theme_id)
        : null;
    }

    const validated = validateThemePackage(
      BUNDLED_DEFAULT_THEME_MANIFEST,
      BUNDLED_DEFAULT_THEME_BUNDLE,
      MICROFEED_VERSION,
    );
    const previewFixture = validatedPreviewFixture(
      validated.manifest,
      BUNDLED_DEFAULT_THEME_PREVIEW_FIXTURE,
    );
    const checksum = await sha256Hex(canonicalThemePackage(
      validated.manifest,
      validated.bundle,
      previewFixture,
    ));
    const existingRow = await this.database.prepare(
      "SELECT * FROM themes WHERE package_id = ? AND version = ? LIMIT 1",
    ).bind(validated.manifest.packageId, validated.manifest.version)
      .first<Record<string, unknown>>();
    const existing = existingRow ? storedThemeFromRow(existingRow) : null;
    if (existing && (existing.deletedAt || existing.checksumSha256 !== checksum)) {
      throw new AppError("errors.theme.bundledDefaultReserved", 400, {
        packageId: validated.manifest.packageId,
        version: validated.manifest.version,
      });
    }
    const defaultThemeId = existing?.id ?? BUNDLED_DEFAULT_THEME_ID;
    await this.database.batch([
      this.database.prepare(
        `INSERT OR IGNORE INTO themes (
          id, package_id, version, name, manifest_json, bundle_json,
          preview_fixture_json, source_kind, source_path, checksum_sha256,
          origin_theme_id, asset_owner_theme_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'bundled', ?, ?, NULL, NULL)`,
      ).bind(
        defaultThemeId,
        validated.manifest.packageId,
        validated.manifest.version,
        validated.manifest.name,
        JSON.stringify(validated.manifest),
        JSON.stringify(validated.bundle),
        JSON.stringify(previewFixture),
        BUNDLED_FALLBACK_THEME.source,
        checksum,
      ),
      this.database.prepare(
        `UPDATE theme_state SET active_theme_id = COALESCE(active_theme_id, ?),
         appearance_preserved_at = CURRENT_TIMESTAMP,
         appearance_preservation_error = NULL,
         updated_at = CURRENT_TIMESTAMP
         WHERE id = 'current' AND appearance_preserved_at IS NULL`,
      ).bind(defaultThemeId),
    ]);
    const preserved = await this.getState();
    if (preserved.activeThemeId === defaultThemeId) {
      await this.purgeActiveTheme();
      return this.getVersion(defaultThemeId);
    }
    return preserved.activeThemeId
      ? await this.getVersion(preserved.activeThemeId)
      : null;
  }

  async ensureThemeMigration(
    settings: Record<string, any> | null | undefined,
  ): Promise<StoredThemeVersion | null> {
    await this.ensureLegacyThemeMigrated(settings);
    return this.ensureAppearancePreserved();
  }

  async installVersion(input: InstallThemeInput): Promise<StoredThemeVersion> {
    const {bundle, manifest} = validateThemePackage(
      input.manifest,
      input.bundle,
      MICROFEED_VERSION,
    );
    const previewFixture = validatedPreviewFixture(
      manifest,
      input.previewFixture,
    );
    assertUserThemePackageId(manifest.packageId);
    const checksum = await sha256Hex(canonicalThemePackage(
      manifest,
      bundle,
      previewFixture,
    ));
    const existing = await this.database.prepare(
      "SELECT * FROM themes WHERE package_id = ? AND version = ? LIMIT 1",
    ).bind(manifest.packageId, manifest.version)
      .first<Record<string, unknown>>();
    if (existing) {
      const theme = storedThemeFromRow(existing);
      if (theme.checksumSha256 !== checksum) {
        throw new AppError("errors.theme.alreadyInstalledDifferentContent", 400, {
          packageId: manifest.packageId,
          version: manifest.version,
        });
      }
      if (theme.deletedAt) {
        throw new AppError("errors.theme.versionReusedAfterDeletion", 400, {
          packageId: manifest.packageId,
          version: manifest.version,
        });
      }
      return theme;
    }

    const id = input.id ?? crypto.randomUUID();
    const assetOwnerThemeId = bundle.assets.length > 0
      ? input.assetOwnerThemeId ?? id
      : input.assetOwnerThemeId ?? null;
    const inserted = await this.database.prepare(
      `INSERT INTO themes (
        id, package_id, version, name, manifest_json, bundle_json,
        preview_fixture_json, source_kind, source_url, source_ref, source_path, source_commit,
        checksum_sha256, origin_theme_id, asset_owner_theme_id
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE (SELECT count(*) FROM themes
               WHERE deleted_at IS NULL AND source_kind != 'bundled') < ?
      RETURNING id`,
    ).bind(
      id,
      manifest.packageId,
      manifest.version,
      manifest.name,
      JSON.stringify(manifest),
      JSON.stringify(bundle),
      previewFixture ? JSON.stringify(previewFixture) : null,
      input.source.kind,
      input.source.url ?? null,
      input.source.ref ?? null,
      input.source.path ?? null,
      input.source.commit ?? null,
      checksum,
      input.originThemeId ?? null,
      assetOwnerThemeId,
      THEME_MAX_CUSTOM_INSTALLED_VERSIONS,
    ).first<{id: string}>();
    if (!inserted) {
      throw new AppError("errors.theme.customVersionLimit", 400, {
        max: String(THEME_MAX_CUSTOM_INSTALLED_VERSIONS),
      });
    }
    const installed = await this.getVersion(id);
    if (!installed) throw new AppError("errors.theme.installedCouldNotLoad");
    return installed;
  }

  async createDraft(input: CreateDraftInput): Promise<ThemeDraft> {
    const source = validateStoredThemePackage(input.manifest, input.bundle);
    const previewFixture = validatedPreviewFixture(
      source.manifest,
      input.previewFixture,
    );
    const packageId = localPackageId(source.manifest.packageId);
    const versionRows = await this.database.prepare(
      `SELECT version FROM themes WHERE package_id = ?
       UNION ALL SELECT version FROM theme_drafts WHERE package_id = ?`,
    ).bind(packageId, packageId).all();
    const version = nextPatchVersion(
      results<{version: string}>(versionRows).map((row) => row.version),
      source.manifest.version,
    );
    const manifest = {
      ...source.manifest,
      name: source.manifest.name.endsWith(" (custom)")
        ? source.manifest.name
        : `${source.manifest.name} (custom)`,
      packageId,
      repository: undefined,
      version,
    } satisfies ThemeManifestV1;
    const id = crypto.randomUUID();
    const inserted = await this.database.prepare(
      `INSERT INTO theme_drafts (
        id, package_id, version, name, manifest_json, bundle_json,
        preview_fixture_json, origin_kind, origin_theme_id, asset_owner_theme_id
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE (SELECT count(*) FROM theme_drafts) < ?
      RETURNING id`,
    ).bind(
      id,
      manifest.packageId,
      manifest.version,
      manifest.name,
      JSON.stringify(manifest),
      JSON.stringify(source.bundle),
      previewFixture ? JSON.stringify(previewFixture) : null,
      input.originKind,
      input.originThemeId ?? null,
      input.assetOwnerThemeId ?? null,
      THEME_MAX_DRAFTS,
    ).first<{id: string}>();
    if (!inserted) {
      throw new AppError("errors.theme.draftLimit", 400, {
        max: String(THEME_MAX_DRAFTS),
      });
    }
    const draft = await this.getDraft(id);
    if (!draft) throw new AppError("errors.theme.draftCouldNotLoad");
    return draft;
  }

  async saveDraft(id: string, input: SaveDraftInput): Promise<ThemeDraft> {
    const existing = await this.getDraft(id);
    if (!existing) throw new AppError("errors.theme.draftNotFound");
    const validated = validateThemePackage(
      input.manifest,
      input.bundle,
      MICROFEED_VERSION,
    );
    if (validated.manifest.packageId !== existing.packageId) {
      throw new AppError("errors.theme.draftPackageIdImmutable");
    }
    if (
      JSON.stringify(validated.manifest.files) !==
        JSON.stringify(existing.manifest.files) ||
      JSON.stringify(validated.manifest.assets) !==
        JSON.stringify(existing.manifest.assets) ||
      validated.manifest.previewFixture !==
        existing.manifest.previewFixture ||
      JSON.stringify(validated.bundle.assets) !==
        JSON.stringify(existing.bundle.assets)
    ) {
      throw new AppError("errors.theme.draftMetadataOnly");
    }
    await this.database.prepare(
      `UPDATE theme_drafts SET version = ?, name = ?, manifest_json = ?,
       bundle_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).bind(
      validated.manifest.version,
      validated.manifest.name,
      JSON.stringify(validated.manifest),
      JSON.stringify(validated.bundle),
      id,
    ).run();
    const draft = await this.getDraft(id);
    if (!draft) throw new AppError("errors.theme.savedDraftCouldNotLoad");
    return draft;
  }

  async discardDraft(id: string, bucket?: R2Bucket | null): Promise<void> {
    const draft = await this.getDraft(id);
    await this.database.prepare("DELETE FROM theme_drafts WHERE id = ?")
      .bind(id).run();
    if (draft?.assetOwnerThemeId) {
      await this.cleanupAssetOwner(draft.assetOwnerThemeId, bucket);
    }
  }

  async publishDraft(id: string): Promise<StoredThemeVersion> {
    const draft = await this.getDraft(id);
    if (!draft) throw new AppError("errors.theme.draftNotFound");
    const validated = validateThemePackage(
      draft.manifest,
      draft.bundle,
      MICROFEED_VERSION,
    );
    const checksum = await sha256Hex(
      canonicalThemePackage(
        validated.manifest,
        validated.bundle,
        draft.previewFixture,
      ),
    );
    const existing = await this.database.prepare(
      "SELECT * FROM themes WHERE package_id = ? AND version = ? LIMIT 1",
    ).bind(draft.packageId, draft.version).first<Record<string, unknown>>();
    if (existing) {
      throw new AppError("errors.theme.draftVersionExists", 400, {
        packageId: draft.packageId,
        version: draft.version,
      });
    }

    const themeId = crypto.randomUUID();
    const inserted = await this.database.prepare(
        `INSERT INTO themes (
          id, package_id, version, name, manifest_json, bundle_json,
          preview_fixture_json, source_kind, checksum_sha256, origin_theme_id,
          asset_owner_theme_id
        ) SELECT ?, ?, ?, ?, ?, ?, ?, 'admin', ?, ?, ?
          WHERE (SELECT count(*) FROM themes
                 WHERE deleted_at IS NULL AND source_kind != 'bundled') < ?
        RETURNING id`,
      ).bind(
        themeId,
        draft.packageId,
        draft.version,
        draft.name,
        JSON.stringify(validated.manifest),
        JSON.stringify(validated.bundle),
        draft.previewFixture ? JSON.stringify(draft.previewFixture) : null,
        checksum,
        draft.originThemeId,
        draft.assetOwnerThemeId,
        THEME_MAX_CUSTOM_INSTALLED_VERSIONS,
      ).first<{id: string}>();
    if (!inserted) {
      throw new AppError("errors.theme.customVersionLimitPublish", 400, {
        max: String(THEME_MAX_CUSTOM_INSTALLED_VERSIONS),
      });
    }
    await this.database.prepare("DELETE FROM theme_drafts WHERE id = ?")
      .bind(id).run();
    const published = await this.getVersion(themeId);
    if (!published) throw new AppError("errors.theme.publishedCouldNotLoad");
    return published;
  }

  async activate(
    id: string,
    commit?: DatabaseMutationCommit<ThemeState>,
  ): Promise<ThemeState> {
    const theme = await this.getVersion(id);
    if (!theme) throw new AppError("errors.theme.notFound");
    validateStoredThemePackage(theme.manifest, theme.bundle, MICROFEED_VERSION);
    const before = await this.getState();
    if (before.activeThemeId === id) return before;
    const now = new Date().toISOString();
    const state: ThemeState = {
      activeThemeId: id,
      previousThemeId: before.activeThemeId,
      updatedAt: now,
    };
    const statement = this.database.prepare(
      `UPDATE theme_state SET previous_theme_id = active_theme_id,
       active_theme_id = ?, updated_at = ?
       WHERE id = 'current'
         AND EXISTS (
           SELECT 1 FROM themes WHERE id = ? AND deleted_at IS NULL
         )`,
    ).bind(id, now, id);
    await commitDatabaseMutation(this.database, [statement], state, commit);
    await this.purgeActiveTheme();
    return state;
  }

  async deactivate(
    commit?: DatabaseMutationCommit<ThemeState>,
  ): Promise<ThemeState> {
    const before = await this.getState();
    if (!before.activeThemeId) return before;
    const now = new Date().toISOString();
    const state: ThemeState = {
      activeThemeId: null,
      previousThemeId: before.activeThemeId,
      updatedAt: now,
    };
    const statement = this.database.prepare(
      `UPDATE theme_state SET previous_theme_id = active_theme_id,
       active_theme_id = NULL, updated_at = ? WHERE id = 'current'`,
    ).bind(now);
    await commitDatabaseMutation(this.database, [statement], state, commit);
    await this.purgeActiveTheme();
    return state;
  }

  async rollback(
    commit?: DatabaseMutationCommit<ThemeState>,
  ): Promise<ThemeState> {
    const before = await this.getState();
    if (before.previousThemeId) {
      const previous = await this.getVersion(before.previousThemeId);
      if (!previous) throw new AppError("errors.theme.previousUnavailable");
      validateStoredThemePackage(
        previous.manifest,
        previous.bundle,
        MICROFEED_VERSION,
      );
    }
    const now = new Date().toISOString();
    const state: ThemeState = {
      activeThemeId: before.previousThemeId,
      previousThemeId: before.activeThemeId,
      updatedAt: now,
    };
    const statement = this.database.prepare(
      `UPDATE theme_state SET active_theme_id = previous_theme_id,
       previous_theme_id = active_theme_id, updated_at = ?
       WHERE id = 'current' AND (
         previous_theme_id IS NULL OR EXISTS (
           SELECT 1 FROM themes
           WHERE id = theme_state.previous_theme_id AND deleted_at IS NULL
         )
       )`,
    ).bind(now);
    await commitDatabaseMutation(this.database, [statement], state, commit);
    await this.purgeActiveTheme();
    return state;
  }

  async deleteVersion(id: string, bucket?: R2Bucket | null): Promise<void> {
    const theme = await this.getVersion(id, true);
    if (!theme) throw new AppError("errors.theme.notFound");
    if (theme.sourceKind === "bundled") {
      throw new AppError("errors.theme.bundledCannotDelete");
    }
    const state = await this.getState();
    if (state.activeThemeId === id) {
      throw new AppError("errors.theme.activeCannotDelete");
    }
    if (!theme.deletedAt) {
      const deleted = await this.database.prepare(
        `UPDATE themes SET deleted_at = CURRENT_TIMESTAMP
         WHERE id = ? AND deleted_at IS NULL AND NOT EXISTS (
           SELECT 1 FROM theme_state
           WHERE id = 'current' AND active_theme_id = ?
         )
         RETURNING id`,
      ).bind(id, id).first<{id: string}>();
      if (!deleted) {
        throw new AppError("errors.theme.becameActiveDuringDelete");
      }
    }
    await this.database.prepare(
      `UPDATE theme_state SET previous_theme_id = NULL,
       updated_at = CURRENT_TIMESTAMP
       WHERE id = 'current' AND previous_theme_id = ?`,
    ).bind(id).run();

    const ownerId = theme.assetOwnerThemeId;
    if (!ownerId) return;
    await this.cleanupAssetOwner(ownerId, bucket);
  }

  /**
   * 物理删除一个自定义版本（purge，ADR-0026 D4）：行从表里移除，不写墓碑。
   *
   * 与 {@link deleteVersion} 的分工：软删除保留行（仍占 `UNIQUE(package_id, version)`，
   * 重装同版本报 `versionReusedAfterDeletion`）；purge 释放该约束，代价是不可恢复。
   * 对已软删除的墓碑行同样有效——批量清理旧版本（`purgeOldVersions`）靠它回收墓碑。
   *
   * 三件必须同时做（AGENTS.md 禁裸 SQL 绕过的理由逐条消除）：
   * 1. 拒绝 bundled 与当前激活行（激活行先停用再删）；
   * 2. 先删行再清 R2 资产——{@link cleanupAssetOwner} 的引用计数只算未删行与草稿，
   *    反序会把这行自己算成引用而跳过清理，留下孤儿资产；
   * 3. `theme_state.previous_theme_id` 指向被删行时清空，否则回滚点悬空。
   */
  async purgeVersion(id: string, bucket?: R2Bucket | null): Promise<void> {
    const theme = await this.getVersion(id, true);
    if (!theme) throw new AppError("errors.theme.notFound");
    if (theme.sourceKind === "bundled") {
      throw new AppError("errors.theme.bundledCannotDelete");
    }
    const state = await this.getState();
    if (state.activeThemeId === id) {
      throw new AppError("errors.theme.activeCannotDelete");
    }
    const deleted = await this.database.prepare(
      `DELETE FROM themes WHERE id = ? AND NOT EXISTS (
         SELECT 1 FROM theme_state
         WHERE id = 'current' AND active_theme_id = ?
       )
       RETURNING asset_owner_theme_id`,
    ).bind(id, id).first<{asset_owner_theme_id: string | null}>();
    if (!deleted) {
      throw new AppError("errors.theme.becameActiveDuringDelete");
    }
    await this.database.prepare(
      `UPDATE theme_state SET previous_theme_id = NULL,
       updated_at = CURRENT_TIMESTAMP
       WHERE id = 'current' AND previous_theme_id = ?`,
    ).bind(id).run();

    const ownerId = theme.assetOwnerThemeId;
    if (!ownerId) return;
    // 删行之后 owner 行可能已经不存在（owner 是自拥有行、已被 purge），那时
    // cleanupAssetOwner 读不到它的资产清单——所以在删行前先把清单拿出来。
    let capturedAssets: readonly {key: string}[];
    if (ownerId === id) {
      capturedAssets = theme.bundle.assets;
    } else {
      const owner = await this.getVersion(ownerId, true);
      // owner 行不在时用本行的 bundle：本行不拥有资产（assetOwnerThemeId 指向
      // owner），bundle.assets 列的正是以 owner 为前缀存放的那一组（派生时整组
      // 继承，ThemeAssets 的媒体前缀只认 assetOwnerThemeId），是仅剩的权威清单。
      capturedAssets = owner ? owner.bundle.assets : theme.bundle.assets;
    }
    await this.cleanupAssetOwner(ownerId, bucket, capturedAssets);
  }

  /**
   * 批量清理旧版本（ADR-0026 D2/D3）：custom 行里 keep 集
   * {active, previous} 之外的全部 purge。live 行与墓碑行都算——墓碑仍占
   * `UNIQUE(package_id, version)`（见 {@link purgeVersion}）。dryRun 只返回
   * 将删清单，不删任何行。
   *
   * 读代价（AGENTS.md:13）：custom 全集一次扫描走全表（`EXPLAIN QUERY PLAN`
   * 实测 `SCAN themes`——source_kind 无索引，themes_created_at / themes_deleted_at /
   * themes_asset_owner 三个索引的谓词都不匹配本查询）。rows_read = themes 全表行数
   * （本地实测 25 行 = custom 17 + bundled 8；生产上界 = bundled 数 + custom 配额 100
   * + 墓碑累积）。SELECT 只取 id / package_id / version / deleted_at 四个窄列，
   * 读取字节按每行约 100 字节估（25 行 ≈ 2.5 KB；100 行 ≈ 10 KB）；manifest 与
   * bundle 两列 JSON 不进投影。keep 集两条主键查各 1 rows_read。表在这个量级
   * 不新增索引。
   *
   * 删除逐行进行、非原子：目标行被并发激活时该行抛错，已删的行不回滚
   * （半清理状态）。与单行 deleteVersion 的语义一致；纯写路径，无新增读。
   */
  async purgeOldVersions(
    bucket?: R2Bucket | null,
    dryRun = false,
  ): Promise<PurgedThemeVersion[]> {
    const state = await this.getState();
    const active = state.activeThemeId
      ? await this.getVersion(state.activeThemeId, true)
      : null;
    if (!active || active.sourceKind === "bundled") {
      throw new AppError("errors.theme.cleanupRequiresCustomActive");
    }
    const keep = new Set(
      [state.activeThemeId, state.previousThemeId].filter(
        (id): id is string => Boolean(id),
      ),
    );
    const rows = results<{
      deleted_at: string | null;
      id: string;
      package_id: string;
      version: string;
    }>(
      await this.database.prepare(
        "SELECT id, package_id, version, deleted_at FROM themes WHERE source_kind != 'bundled'",
      ).all(),
    );
    const targets = rows
      .filter((row) => !keep.has(row.id))
      .map((row) => ({
        id: row.id,
        packageId: row.package_id,
        tombstone: row.deleted_at !== null,
        version: row.version,
      }));
    if (dryRun) return targets;
    for (const row of targets) {
      await this.purgeVersion(row.id, bucket);
    }
    return targets;
  }

  private async cleanupAssetOwner(
    ownerId: string,
    bucket?: R2Bucket | null,
    capturedAssets?: readonly {key: string}[] | null,
  ): Promise<void> {
    const references = await this.database.prepare(
      `SELECT (
        SELECT count(*) FROM themes
        WHERE deleted_at IS NULL AND asset_owner_theme_id = ?
      ) + (
        SELECT count(*) FROM theme_drafts WHERE asset_owner_theme_id = ?
      ) AS count`,
    ).bind(ownerId, ownerId).first<{count: number}>();
    if ((references?.count ?? 0) > 0) return;

    // owner 行已被 purge 时用调用前捕获的资产清单；账目列随行消失，跳过记账。
    const owner = await this.getVersion(ownerId, true);
    const assets = owner?.bundle.assets ?? capturedAssets ?? [];
    if (assets.length === 0) return;

    try {
      if (!bucket) throw new AppError("errors.theme.r2Unavailable");
      await bucket.delete(assets.map((asset) => asset.key));
      if (owner) {
        await this.database.prepare(
          `UPDATE themes SET assets_deleted_at = CURRENT_TIMESTAMP,
           asset_cleanup_error = NULL WHERE id = ?`,
        ).bind(ownerId).run();
      }
    } catch (error) {
      if (owner) {
        await this.database.prepare(
          "UPDATE themes SET asset_cleanup_error = ? WHERE id = ?",
        ).bind(
          error instanceof Error ? error.message : String(error),
          ownerId,
        ).run();
      }
      throw error;
    }
  }
}
