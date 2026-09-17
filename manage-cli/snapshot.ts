/**
 * Snapshot, backup, and restore support for the management CLI.
 *
 * Split out of commands.ts, which had grown past 8400 lines. Shared helpers
 * come from ./lib/deploySupport, so the dependency runs one way only:
 * commands.ts imports the restore helpers it needs from here, and this module
 * never imports commands.ts.
 */
import {
createReadStream, createWriteStream} from "node:fs";
import {createHash, randomBytes, randomUUID} from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {Readable, Transform} from "node:stream";
import {pipeline} from "node:stream/promises";
import {isDeepStrictEqual} from "node:util";
import {Miniflare} from "miniflare";
import DEFAULT_THEME_MANIFEST from "../themes/default/microfeed-theme.json";

import {
  DEFAULT_ITEMS_PER_PAGE,
  ITEMS_SORT_ORDERS,
  PREDEFINED_SUBSCRIBE_METHODS,
  SETTINGS_CATEGORIES,
  STATUSES,
} from "@/shared/Constants";
import {ITEM_ORDERS, ITEM_SORTS} from "@/shared/ItemPagination";
import {DEFAULT_CHANNEL_COPYRIGHT} from "@/shared/TemplateVariables";

import {
  normalizeOwnerEmail,
  validateOwnerEmail,
} from "./lib/auth";
import {
  adminAuthMode,
  cloudflareAccountId,
  ensureLocalOnlyConfig,
  ensureWranglerConfig,
  instanceDirectory,
  isR2Ready,
  localPersistencePath,
  markStep,
  readConfig,
  removeSavedInstance,
  setActiveInstance,
  validateLocalInstanceName,
  workerName,
  writeConfig,
} from "./lib/config";
import {
  CloudflareClient,
} from "./lib/cloudflare";
import {
  repositoryRoot,
  runCommand,
} from "./lib/process";

import {
  prompts,
  type WaitActivity,
  withSpinner,
} from "./lib/prompts";

import {
  applicationTablesFromSqlite,
  assertClassifiedTables,
  buildRestoreFinalizationSql,
  buildRestoreSql,
  createSnapshotArchive,
  extractSnapshotArchive,
  migrationIndexDefinitions,
  repositoryMigrations,
  type SnapshotIndexDefinition,
  type SnapshotManifest,
  type SnapshotMigration,
  type SnapshotR2Object,
  SNAPSHOT_FORMAT,
  SNAPSHOT_TABLES,
  SNAPSHOT_VERSION,
  sha256File,
  validateAppliedMigrationPrefix,
  validateSnapshotMigrations,
  writeSnapshotManifest,
} from "./lib/snapshot";
import {
  dropItemSearchIndexes,
  prepareItemSearch,
  withItemSearchIndexesSuspended,
} from "./lib/item-search";
import {
  type CommandContext,
  type Flags,
  authenticate,
  databaseIndexDefinitions,
  databaseTableNames,
  deployConfiguredProject,
  deploymentVerificationUrl,
  durableRowCounts,
  errorMessage,
  flagBoolean,
  flagString,
  hasCompletedCloudflareInitialization,
  migrationLedger,
  remoteRestoreFingerprint,
  resolveCommandInstance,
  snapshotOutputPath,
  verifyDeployment,
  wait,
} from "./lib/deploySupport";
import type {CommandRunner, MicrofeedConfig} from "./types";
const SNAPSHOT_PROGRESS_REPORT_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_PROGRESS_REPORT_MS = 1_000;

export function formatSnapshotBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const displayed = unitIndex === 0
    ? String(Math.round(value))
    : value >= 10
      ? value.toFixed(0)
      : value.toFixed(1);
  return `${displayed} ${units[unitIndex]}`;
}

export function snapshotMediaProgressMessage(input: {
  downloadedBytes: number;
  objectCount: number;
  objectNumber: number;
  totalBytes: number;
}): string {
  if (input.objectCount === 0) {
    return "R2 media bucket is empty; no objects to download";
  }
  return `Downloading R2 media: object ${input.objectNumber} of ${input.objectCount}; ` +
    `${formatSnapshotBytes(input.downloadedBytes)} of ${formatSnapshotBytes(input.totalBytes)}`;
}

export function snapshotCreatedMessage(output: string): string {
  return `✅ Snapshot created at ${output}. It contains sensitive data, is ` +
    "unencrypted, and is readable only by your user account.";
}

export function localSnapshotNextSteps(
  instanceName: string,
  needsLoginSetup: boolean,
): string {
  const startCommand = `yarn dev --instance ${instanceName}`;
  if (!needsLoginSetup) {
    return `Run \`${startCommand}\` to start it.`;
  }
  return [
    "Set up the local dashboard login:",
    "",
    "yarn manage auth setup \\",
    `  --instance ${instanceName}`,
    "",
    `Then run \`${startCommand}\` to start it.`,
  ].join("\n");
}

export function remoteSnapshotNextSteps(
  instanceName: string,
  needsLoginSetup: boolean,
): string {
  const completed = `Remote restore complete for ${instanceName}.`;
  if (!needsLoginSetup) return completed;
  return [
    completed,
    "",
    "The snapshot did not contain an administrator login. Set it up now:",
    "",
    "yarn manage auth setup \\",
    `  --instance ${instanceName}`,
  ].join("\n");
}

export function remoteRestoreTargetReadinessError(
  config: MicrofeedConfig,
): string | null {
  if (config.restoreBaseline && isR2Ready(config)) {
    return null;
  }
  const reasons: string[] = [];
  if (!isR2Ready(config)) {
    reasons.push(
      "R2 media storage is not ready. Enable it with " +
        `\`yarn manage deploy --enable-r2 --instance ${config.instanceName}\` ` +
        "before restoring a snapshot.",
    );
  }
  if (!config.restoreBaseline) {
    reasons.push(hasCompletedCloudflareInitialization(config)
      ? "The CLI has no fresh-target safety fingerprint, so it cannot prove " +
        "that this instance's D1 database and R2 bucket are fresh and " +
        "unchanged."
      : "Initialization did not finish successfully, so the CLI never " +
        "recorded the fresh-target safety fingerprint for its D1 database " +
        "and R2 bucket.");
  }
  if (config.d1.reuse) {
    reasons.push(
      `D1 database \`${config.d1.name}\` is marked as reused.`,
    );
  }
  if (config.r2.reuse) {
    reasons.push(
      `R2 bucket \`${config.r2.name}\` is marked as reused.`,
    );
  }
  const recovery = hasCompletedCloudflareInitialization(config)
    ? "Run the restore with `--dry-run`. The CLI will automatically repair " +
      "the missing fingerprint only if the deployed Worker belongs to this " +
      "instance, D1 contains no user-created content, and R2 is empty."
    : "Initialization must complete successfully before you retry remote " +
      "restore.";
  return `Snapshot archive validation passed, but instance \`${config.instanceName}\` ` +
    `is not ready for remote restore. ${reasons.join(" ")} ${recovery} ` +
    "Remote restore did not start; no target data was changed.";
}

export function canRepairRemoteRestoreBaseline(
  config: MicrofeedConfig,
): boolean {
  return !config.restoreBaseline &&
    isR2Ready(config) &&
    hasCompletedCloudflareInitialization(config);
}

export function validateRemoteRestoreBaselineRepair(input: {
  allowInitialPasswordSetup: boolean;
  applicationRowCounts: Record<string, number>;
  applicationTables: readonly string[];
  appliedMigrations: readonly string[];
  bootstrapChannelRows: readonly Record<string, unknown>[];
  bootstrapSettingRows: readonly Record<string, unknown>[];
  bootstrapWorkerName: string;
  currentIndexes: readonly string[];
  currentMigrations: readonly string[];
  expectedInstanceId: string;
  expectedIndexes: readonly string[];
  expectedPublicOrigins: readonly string[];
  initialPasswordSetupRows: readonly Record<string, unknown>[];
  installationInstanceIds: readonly string[];
  r2ObjectCount: number;
  themeRows?: readonly Record<string, unknown>[];
  themeStateRows?: readonly Record<string, unknown>[];
}): void {
  assertClassifiedTables(input.applicationTables);
  const expectedTables = [
    ...SNAPSHOT_TABLES.durable,
    ...SNAPSHOT_TABLES.ephemeral,
    ...SNAPSHOT_TABLES.targetSpecific,
  ].sort((left, right) => left.localeCompare(right));
  const expectedTableSet = new Set<string>(expectedTables);
  const actualTables = [...input.applicationTables]
    .sort((left, right) => left.localeCompare(right));
  const missingTables = expectedTables.filter((table) =>
    !actualTables.includes(table)
  );
  const unexpectedTables = actualTables.filter((table) =>
    !expectedTableSet.has(table)
  );
  if (missingTables.length > 0 || unexpectedTables.length > 0) {
    const problems = [
      ...(missingTables.length > 0
        ? [`Missing tables: ${missingTables.join(", ")}.`]
        : []),
      ...(unexpectedTables.length > 0
        ? [`Unexpected tables: ${unexpectedTables.join(", ")}.`]
        : []),
    ];
    throw new Error(
      "The remote D1 schema is not the current freshly initialized schema. " +
        problems.join(" "),
    );
  }
  if (
    input.appliedMigrations.length !== input.currentMigrations.length ||
    input.appliedMigrations.some((migration, index) =>
      migration !== input.currentMigrations[index]
    )
  ) {
    throw new Error(
      "The remote D1 migration ledger is not at this checkout's current head.",
    );
  }
  const currentIndexes = [...input.currentIndexes]
    .sort((left, right) => left.localeCompare(right));
  const expectedIndexes = [...input.expectedIndexes]
    .sort((left, right) => left.localeCompare(right));
  if (
    currentIndexes.length !== expectedIndexes.length ||
    currentIndexes.some((index, position) => index !== expectedIndexes[position])
  ) {
    throw new Error(
      "The remote D1 indexes do not match this checkout's current migrations.",
    );
  }
  const nonemptyNonBootstrapTables = Object.entries(input.applicationRowCounts)
    .filter(([table, count]) =>
      count !== 0 &&
      table !== "channels" &&
      table !== "settings" &&
      table !== "auth_password_setup" &&
      table !== "theme_state" &&
      table !== "themes"
    )
    .map(([table]) => table)
    .sort((left, right) => left.localeCompare(right));
  if (nonemptyNonBootstrapTables.length > 0) {
    throw new Error(
      "The remote D1 database contains application data in: " +
        `${nonemptyNonBootstrapTables.join(", ")}. It cannot be repaired as a fresh ` +
        "snapshot restore target.",
    );
  }
  validateRemoteRestoreBootstrapRows(input);
  validateRemoteRestoreInitialPasswordSetup(input);
  validateRemoteRestoreThemeState(input);
  if (
    input.installationInstanceIds.length !== 1 ||
    input.installationInstanceIds[0] !== input.expectedInstanceId
  ) {
    throw new Error(
      "The remote D1 installation identity does not match this instance.",
    );
  }
  if (input.r2ObjectCount !== 0) {
    throw new Error(
      "The remote R2 bucket is not empty, so it cannot be repaired as a " +
        "fresh snapshot restore target.",
    );
  }
}

function validateRemoteRestoreThemeState(input: {
  applicationRowCounts: Record<string, number>;
  themeRows?: readonly Record<string, unknown>[];
  themeStateRows?: readonly Record<string, unknown>[];
}): void {
  const count = input.applicationRowCounts.theme_state ?? 0;
  const themeCount = input.applicationRowCounts.themes ?? 0;
  const themes = input.themeRows ?? [];
  const rows = input.themeStateRows ?? [];
  if (count === 0 && rows.length === 0 && themeCount === 0 && themes.length === 0) return;
  const row = rows[0];
  const theme = themes[0];
  const oldInactiveState = themeCount === 0 && themes.length === 0 &&
    row?.active_theme_id === null;
  const bundledDefaultState = themeCount === 1 && themes.length === 1 &&
    typeof row?.active_theme_id === "string" &&
    row.active_theme_id === theme?.id &&
    theme?.package_id === DEFAULT_THEME_MANIFEST.packageId &&
    theme?.version === DEFAULT_THEME_MANIFEST.version &&
    theme?.source_kind === "bundled" &&
    theme?.deleted_at === null;
  if (
    count !== 1 ||
    rows.length !== 1 ||
    row?.id !== "current" ||
    row.previous_theme_id !== null ||
    (!oldInactiveState && !bundledDefaultState)
  ) {
    throw new Error(
      "The remote D1 theme state is not the automatic inactive state of a fresh instance.",
    );
  }
}

function validateRemoteRestoreInitialPasswordSetup(input: {
  allowInitialPasswordSetup: boolean;
  applicationRowCounts: Record<string, number>;
  initialPasswordSetupRows: readonly Record<string, unknown>[];
}): void {
  const count = input.applicationRowCounts.auth_password_setup ?? 0;
  if (count === 0 && input.initialPasswordSetupRows.length === 0) return;
  const row = input.initialPasswordSetupRows[0];
  const createdAt = typeof row?.createdAt === "string"
    ? Date.parse(row.createdAt)
    : Number.NaN;
  const expiresAt = typeof row?.expiresAt === "string"
    ? Date.parse(row.expiresAt)
    : Number.NaN;
  const setupWindow = expiresAt - createdAt;
  if (
    !input.allowInitialPasswordSetup ||
    count !== 1 ||
    input.initialPasswordSetupRows.length !== 1 ||
    row?.id !== "owner" ||
    row.purpose !== "initial" ||
    row.userId !== null ||
    typeof row.email !== "string" ||
    validateOwnerEmail(row.email) !== undefined ||
    row.email !== normalizeOwnerEmail(row.email) ||
    typeof row.tokenHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(row.tokenHash) ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    setupWindow <= 0 ||
    setupWindow > 31 * 60 * 1_000
  ) {
    throw new Error(
      "The remote D1 password setup state is not the one-time initial login " +
        "record created for a fresh instance.",
    );
  }
}

function parsedJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function targetBootstrapLink(
  value: unknown,
  expectedOrigins: readonly string[],
  workerName: string,
): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" || url.pathname !== "/" || url.search ||
      url.hash
    ) {
      return false;
    }
    if (expectedOrigins.includes(url.origin)) return true;
    return url.hostname.startsWith(`${workerName}.`) &&
      url.hostname.endsWith(".workers.dev");
  } catch {
    return false;
  }
}

function validBootstrapSubscribeMethod(
  value: unknown,
  expected: Record<string, unknown>,
): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = value as Record<string, unknown>;
  if (
    typeof actual.id !== "string" ||
    !/^[A-Za-z0-9_-]{11}$/u.test(actual.id)
  ) {
    return false;
  }
  return isDeepStrictEqual(
    {...actual, id: "<generated>"},
    {...expected, editable: false, enabled: true, id: "<generated>"},
  );
}

function validateRemoteRestoreBootstrapRows(input: {
  applicationRowCounts: Record<string, number>;
  bootstrapChannelRows: readonly Record<string, unknown>[];
  bootstrapSettingRows: readonly Record<string, unknown>[];
  bootstrapWorkerName: string;
  expectedPublicOrigins: readonly string[];
}): void {
  const channelCount = input.applicationRowCounts.channels ?? 0;
  const settingCount = input.applicationRowCounts.settings ?? 0;
  if (channelCount === 0 && settingCount === 0) return;
  if (
    channelCount !== 1 || settingCount !== 5 ||
    input.bootstrapChannelRows.length !== 1 ||
    input.bootstrapSettingRows.length !== 5
  ) {
    throw new Error(
      "The remote D1 channels and settings are not the automatic bootstrap " +
        "rows of a fresh microfeed instance.",
    );
  }

  const channelRow = input.bootstrapChannelRows[0]!;
  const channel = parsedJsonRecord(channelRow.data);
  if (!channel) {
    throw new Error("The remote D1 bootstrap channel contains invalid data.");
  }
  const {copyright, link, ...channelRest} = channel;
  if (
    typeof channelRow.id !== "string" ||
    !/^[A-Za-z0-9_-]{11}$/u.test(channelRow.id) ||
    Number(channelRow.status) !== STATUSES.PUBLISHED ||
    Number(channelRow.is_primary) !== 1 ||
    copyright !== DEFAULT_CHANNEL_COPYRIGHT ||
    !targetBootstrapLink(
      link,
      input.expectedPublicOrigins,
      input.bootstrapWorkerName,
    ) ||
    !isDeepStrictEqual(channelRest, {
      categories: [],
      image: "/assets/default/channel-image.png",
      "itunes:block": false,
      "itunes:complete": false,
      "itunes:explicit": false,
      "itunes:type": "episodic",
      language: "en-us",
    })
  ) {
    throw new Error(
      "The remote D1 channel is not the automatic bootstrap channel of this " +
        "fresh microfeed instance.",
    );
  }

  const settings = new Map<string, Record<string, unknown>>();
  for (const row of input.bootstrapSettingRows) {
    if (typeof row.category !== "string") continue;
    const data = parsedJsonRecord(row.data);
    if (data) settings.set(row.category, data);
  }
  const subscribeMethods = settings.get(SETTINGS_CATEGORIES.SUBSCRIBE_METHODS);
  const methods = subscribeMethods?.methods;
  const webGlobalSettings = settings.get(
    SETTINGS_CATEGORIES.WEB_GLOBAL_SETTINGS,
  );
  const sharedWebGlobalSettings = {
    favicon: {
      contentType: "image/png",
      url: "/assets/default/favicon.png",
    },
    itemsPerPage: DEFAULT_ITEMS_PER_PAGE,
    publicBucketUrl: "/media/",
  };
  const validWebGlobalSettings = isDeepStrictEqual(webGlobalSettings, {
    ...sharedWebGlobalSettings,
    itemsOrder: ITEM_ORDERS.DESC,
    itemsSort: ITEM_SORTS.PUBLISHED_AT,
  }) || isDeepStrictEqual(webGlobalSettings, {
    ...sharedWebGlobalSettings,
    itemsSortOrder: ITEMS_SORT_ORDERS.NEWEST_FIRST,
  });
  if (
    settings.size !== 5 || !Array.isArray(methods) || methods.length !== 2 ||
    !validBootstrapSubscribeMethod(
      methods[0],
      PREDEFINED_SUBSCRIBE_METHODS.rss,
    ) ||
    !validBootstrapSubscribeMethod(
      methods[1],
      PREDEFINED_SUBSCRIBE_METHODS.json,
    ) ||
    !validWebGlobalSettings ||
    !isDeepStrictEqual(settings.get(SETTINGS_CATEGORIES.ACCESS), {
      currentPolicy: "public",
    }) ||
    !isDeepStrictEqual(settings.get(SETTINGS_CATEGORIES.ANALYTICS), {}) ||
    !isDeepStrictEqual(settings.get(SETTINGS_CATEGORIES.CUSTOM_CODE), {})
  ) {
    throw new Error(
      "The remote D1 settings are not the automatic bootstrap settings of " +
        "a fresh microfeed instance.",
    );
  }
}

export async function assertFreshRemoteRestoreBaselineTarget(
  context: CommandContext,
  config: MicrofeedConfig,
): Promise<void> {
  const tableNames = await databaseTableNames(context.cloudflare, config);
  const applicationTables = applicationTablesFromSqlite(tableNames);
  const targetSpecificTables = new Set<string>(SNAPSHOT_TABLES.targetSpecific);
  const countedTables = applicationTables.filter((table) =>
    !targetSpecificTables.has(table)
  );
  const [appliedMigrations, currentMigrations, currentIndexes, expectedIndexes,
    rowCounts, channels, settings, passwordSetups, themes, themeState, installations, objects] =
    await Promise.all([
      migrationLedger(context.cloudflare, config),
      repositoryMigrations(),
      databaseIndexDefinitions(context.cloudflare, config, applicationTables),
      repositoryIndexDefinitions(),
      durableRowCounts(context.cloudflare, config, countedTables),
      context.cloudflare.queryD1(
        config,
        "SELECT id, status, is_primary, data FROM channels ORDER BY id",
      ),
      context.cloudflare.queryD1(
        config,
        "SELECT category, data FROM settings ORDER BY category",
      ),
      context.cloudflare.queryD1(
        config,
        "SELECT id, purpose, email, userId, tokenHash, createdAt, expiresAt " +
          "FROM auth_password_setup ORDER BY id",
      ),
      context.cloudflare.queryD1(
        config,
        "SELECT id, package_id, version, source_kind, deleted_at FROM themes ORDER BY id",
      ),
      context.cloudflare.queryD1(
        config,
        "SELECT id, active_theme_id, previous_theme_id FROM theme_state ORDER BY id",
      ),
      context.cloudflare.queryD1(
        config,
        "SELECT instanceId FROM microfeed_installation ORDER BY id",
      ),
      context.cloudflare.listR2Objects(
        cloudflareAccountId(config),
        config.r2.name,
      ),
    ]);
  validateRemoteRestoreBaselineRepair({
    allowInitialPasswordSetup: adminAuthMode(config) === "built-in",
    applicationRowCounts: rowCounts,
    applicationTables,
    appliedMigrations,
    bootstrapChannelRows: channels,
    bootstrapSettingRows: settings,
    bootstrapWorkerName: workerName(config),
    currentIndexes: currentIndexes.map(({name}) => name),
    currentMigrations: currentMigrations.map(({filename}) => filename),
    expectedIndexes: expectedIndexes.map(({name}) => name),
    expectedInstanceId: config.instanceId,
    expectedPublicOrigins: [
      config.deploymentUrl,
      deploymentVerificationUrl(config),
    ].flatMap((value) => {
      if (!value) return [];
      try {
        return [new URL(value).origin];
      } catch {
        return [];
      }
    }),
    initialPasswordSetupRows: passwordSetups,
    installationInstanceIds: installations.flatMap(({instanceId}) =>
      typeof instanceId === "string" ? [instanceId] : []
    ),
    r2ObjectCount: objects.length,
    themeRows: themes,
    themeStateRows: themeState,
  });
}

export function remoteRestoreBaselineRepairNotice(
  config: MicrofeedConfig,
): {message: string; title: string} {
  return {
    message: [
      `Instance: ${config.instanceName}`,
      `D1 database: ${config.d1.name} (${config.d1.id})`,
      `R2 bucket: ${config.r2.name}`,
      "Worker identity: matches this saved instance",
      "D1 content: automatic first-run defaults only; no user-created " +
        "content found",
      "R2 content: empty",
      "Snapshot restore: not started",
      "Cloudflare changes: none",
      "Local safety record: saving automatically so the later restore will " +
        "refuse to start if this target changes",
      "",
      "D1 and R2 ownership flags stay unchanged; resources already marked " +
        "reused remain protected from `yarn manage destroy`.",
    ].join("\n"),
    title: "Fresh snapshot restore target verified",
  };
}

async function assertFreshRemoteRestoreTarget(
  context: CommandContext,
  config: MicrofeedConfig,
  activity: WaitActivity,
): Promise<void> {
  const accountId = cloudflareAccountId(config);
  activity.update("Checking the exact D1 database identity");
  const databases = await context.cloudflare.d1Databases(accountId);
  const database = databases.find(({id}) => id === config.d1.id);
  if (!database || database.name !== config.d1.name) {
    throw new Error(
      `D1 database \`${config.d1.name}\` (${config.d1.id}) was not found ` +
        "with the saved identity.",
    );
  }

  activity.update("Checking the deployed Worker installation identity");
  const verificationUrl = deploymentVerificationUrl(config);
  if (!verificationUrl) {
    throw new Error("The initialized instance has no deployment URL.");
  }
  await verifyDeployment(config, verificationUrl, {runner: context.runner});

  activity.update("Checking the D1 schema, migrations, and empty tables");
  await assertFreshRemoteRestoreBaselineTarget(context, config);
}

export async function saveVerifiedRemoteRestoreBaseline(
  context: CommandContext,
  config: MicrofeedConfig,
  activity: WaitActivity,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    activity.update("Recording the verified D1 and R2 state");
    const fingerprint = await remoteRestoreFingerprint(
      context.cloudflare,
      config,
    );
    activity.update("Rechecking that the target stayed fresh");
    await assertFreshRemoteRestoreBaselineTarget(context, config);
    const recheckedFingerprint = await remoteRestoreFingerprint(
      context.cloudflare,
      config,
    );
    if (recheckedFingerprint === fingerprint) {
      config.restoreBaseline = {
        createdAt: new Date().toISOString(),
        fingerprint,
      };
      await writeConfig(config);
      return;
    }
  }
  throw new Error(
    "The remote target kept changing while its fresh state was being checked. " +
      "Wait for other requests or deployments to finish, then retry.",
  );
}

export async function reverifyRemoteRestoreTargetIfFingerprintChanged(input: {
  currentFingerprint: string;
  expectedFingerprint: string;
  reverify: () => Promise<void>;
}): Promise<boolean> {
  if (input.currentFingerprint === input.expectedFingerprint) return false;
  await input.reverify();
  return true;
}

async function repairRemoteRestoreBaseline(
  context: CommandContext,
  config: MicrofeedConfig,
): Promise<void> {
  await withSpinner(
    {
      error: "Could not repair the remote restore safety fingerprint",
      start: "Proving that the initialized remote target is still empty",
      success: "Remote target is fresh and belongs to this instance",
    },
    (activity) => assertFreshRemoteRestoreTarget(context, config, activity),
  );

  const notice = remoteRestoreBaselineRepairNotice(config);
  prompts.note(notice.message, notice.title);
  await withSpinner(
    {
      error: "Could not save the fresh-target verification",
      start: "Saving the fresh-target verification locally",
      success: "Fresh-target verification saved locally; continuing the dry run",
    },
    async (activity) => {
      await saveVerifiedRemoteRestoreBaseline(context, config, activity);
    },
  );
}

async function assertPathDoesNotExist(filename: string): Promise<void> {
  try {
    await stat(filename);
    throw new Error(
      `Refusing to overwrite existing snapshot file ${filename}. Choose another --output path.`,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function downloadSnapshotObject(
  cloudflare: CloudflareClient,
  config: MicrofeedConfig,
  object: Awaited<ReturnType<CloudflareClient["listR2Objects"]>>[number],
  filename: string,
  onBytes?: (bytes: number) => void,
): Promise<{sha256: string; size: number}> {
  const response = await cloudflare.r2ObjectResponse(
    cloudflareAccountId(config),
    config.r2.name,
    object.key,
  );
  if (!response.body) {
    throw new Error(`Cloudflare returned no body for R2 object ${object.key}.`);
  }
  const hash = createHash("sha256");
  let size = 0;
  const checksum = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      size += chunk.length;
      onBytes?.(chunk.length);
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as never),
    checksum,
    createWriteStream(filename, {mode: 0o600}),
  );
  if (size !== object.size) {
    throw new Error(
      `R2 object ${object.key} changed size while the snapshot was being created. Retry after writes have stopped.`,
    );
  }
  return {sha256: hash.digest("hex"), size};
}

async function createRemoteSnapshot(
  context: CommandContext,
  output: string,
  progress: (message: string) => void = () => undefined,
): Promise<string> {
  progress("Checking the source instance and Cloudflare access");
  await assertPathDoesNotExist(output);
  const config = await ensureWranglerConfig(false, false, context.instanceName);
  if (config.deploymentEnvironment === "preview") {
    throw new Error("Preview environments cannot create portable snapshots.");
  }
  if (!isR2Ready(config)) {
    throw new Error(
      `Portable snapshots require R2 media storage. Run ` +
        `\`yarn manage deploy --enable-r2 --instance ${config.instanceName}\` ` +
        "before creating or pulling a snapshot.",
    );
  }
  const accountId = cloudflareAccountId(config);
  const account = await authenticate(context, accountId);
  if (account.id !== accountId) {
    throw new Error(`This installation belongs to Cloudflare account ${accountId}.`);
  }
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "microfeed-snapshot-create-"),
  );
  try {
    const databaseDirectory = path.join(temporaryDirectory, "database");
    const mediaDirectory = path.join(temporaryDirectory, "media");
    await Promise.all([
      mkdir(databaseDirectory, {recursive: true}),
      mkdir(mediaDirectory, {recursive: true}),
    ]);
    progress("Inspecting D1 schema and migration history");
    const migrations = await repositoryMigrations();
    const tableNames = await databaseTableNames(context.cloudflare, config);
    const applicationTables = applicationTablesFromSqlite(tableNames);
    assertClassifiedTables(applicationTables);
    const ledgerBefore = await migrationLedger(context.cloudflare, config);
    const appliedMigrations = validateAppliedMigrationPrefix(
      ledgerBefore,
      migrations,
    );
    const schemaPath = path.join(databaseDirectory, "schema.sql");
    const dataPath = path.join(databaseDirectory, "data.sql");
    const durableTables = SNAPSHOT_TABLES.durable.filter((table) =>
      applicationTables.includes(table)
    );
    await withItemSearchIndexesSuspended(
      context.cloudflare,
      config,
      async () => {
        progress("Exporting the D1 schema");
        await context.cloudflare.exportD1(
          config,
          schemaPath,
          [...applicationTables, "d1_migrations"],
          "schema",
        );
        progress("Capturing explicit D1 indexes");
        const indexDefinitions = await databaseIndexDefinitions(
          context.cloudflare,
          config,
          applicationTables,
        );
        const exportedIndexNames = new Set(
          migrationIndexDefinitions(await readFile(schemaPath, "utf8"))
            .map(({name}) => name),
        );
        const missingIndexDefinitions = indexDefinitions.filter(
          ({name}) => !exportedIndexNames.has(name),
        );
        if (missingIndexDefinitions.length > 0) {
          await appendFile(
            schemaPath,
            `\n${missingIndexDefinitions.map(({sql}) => sql).join("\n")}\n`,
            "utf8",
          );
        }
        progress("Exporting durable D1 data and the migration ledger");
        await context.cloudflare.exportD1(
          config,
          dataPath,
          [...durableTables, "d1_migrations"],
          "data",
        );
      },
    );
    progress("Counting durable D1 rows for restore verification");
    const rowCounts = await durableRowCounts(
      context.cloudflare,
      config,
      durableTables,
    );
    progress("Listing R2 media objects");
    const listedObjects = await context.cloudflare.listR2Objects(
      accountId,
      config.r2.name,
    );
    const totalMediaBytes = listedObjects.reduce(
      (total, object) => total + object.size,
      0,
    );
    let downloadedMediaBytes = 0;
    let lastReportedBytes = 0;
    let lastReportedAt = Date.now();
    const objects: SnapshotR2Object[] = [];
    progress(snapshotMediaProgressMessage({
      downloadedBytes: 0,
      objectCount: listedObjects.length,
      objectNumber: listedObjects.length > 0 ? 1 : 0,
      totalBytes: totalMediaBytes,
    }));
    for (const [index, object] of listedObjects.entries()) {
      const archivePath = `media/${String(index + 1).padStart(8, "0")}`;
      progress(snapshotMediaProgressMessage({
        downloadedBytes: downloadedMediaBytes,
        objectCount: listedObjects.length,
        objectNumber: index + 1,
        totalBytes: totalMediaBytes,
      }));
      const stored = await downloadSnapshotObject(
        context.cloudflare,
        config,
        object,
        path.join(temporaryDirectory, archivePath),
        (bytes) => {
          downloadedMediaBytes += bytes;
          const now = Date.now();
          if (
            downloadedMediaBytes === totalMediaBytes ||
            downloadedMediaBytes - lastReportedBytes >=
              SNAPSHOT_PROGRESS_REPORT_BYTES ||
            now - lastReportedAt >= SNAPSHOT_PROGRESS_REPORT_MS
          ) {
            progress(snapshotMediaProgressMessage({
              downloadedBytes: downloadedMediaBytes,
              objectCount: listedObjects.length,
              objectNumber: index + 1,
              totalBytes: totalMediaBytes,
            }));
            lastReportedBytes = downloadedMediaBytes;
            lastReportedAt = now;
          }
        },
      );
      progress(snapshotMediaProgressMessage({
        downloadedBytes: downloadedMediaBytes,
        objectCount: listedObjects.length,
        objectNumber: index + 1,
        totalBytes: totalMediaBytes,
      }));
      objects.push({
        archivePath,
        customMetadata: object.customMetadata,
        etag: object.etag,
        httpMetadata: object.httpMetadata,
        key: object.key,
        sha256: stored.sha256,
        size: stored.size,
        storageClass: object.storageClass,
        uploaded: object.uploaded,
      });
    }
    progress("Verifying D1 and R2 did not change during export");
    const [ledgerAfter, listedAfter] = await Promise.all([
      migrationLedger(context.cloudflare, config),
      context.cloudflare.listR2Objects(accountId, config.r2.name),
    ]);
    if (JSON.stringify(ledgerAfter) !== JSON.stringify(ledgerBefore)) {
      throw new Error(
        "The D1 migration ledger changed during export. The incomplete snapshot was discarded; retry after deployment finishes.",
      );
    }
    if (JSON.stringify(listedAfter) !== JSON.stringify(listedObjects)) {
      throw new Error(
        "The R2 bucket changed during export. The incomplete snapshot was discarded; retry after media writes have stopped.",
      );
    }
    const tables = Object.fromEntries(
      (Object.keys(SNAPSHOT_TABLES) as Array<keyof typeof SNAPSHOT_TABLES>)
        .map((category) => [
          category,
          SNAPSHOT_TABLES[category].filter((table) =>
            tableNames.includes(table)
          ),
        ]),
    ) as SnapshotManifest["database"]["tables"];
    progress("Writing the checksummed snapshot manifest");
    const manifest: SnapshotManifest = {
      createdAt: new Date().toISOString(),
      database: {
        data: {path: "database/data.sql", sha256: await sha256File(dataPath)},
        migrations: appliedMigrations,
        rowCounts,
        schema: {
          path: "database/schema.sql",
          sha256: await sha256File(schemaPath),
        },
        tables,
      },
      format: SNAPSHOT_FORMAT,
      media: {
        objectCount: objects.length,
        objects,
        totalBytes: objects.reduce((total, object) => total + object.size, 0),
      },
      source: {
        databaseName: config.d1.name,
        deploymentEnvironment: "production",
        instanceName: config.instanceName,
        projectName: config.projectName,
        r2BucketName: config.r2.name,
      },
      version: SNAPSHOT_VERSION,
    };
    await writeSnapshotManifest(temporaryDirectory, manifest);
    progress(`Compressing the snapshot into ${path.basename(output)}`);
    await createSnapshotArchive(temporaryDirectory, output);
    return output;
  } catch (error) {
    await rm(output, {force: true});
    throw error;
  } finally {
    await rm(temporaryDirectory, {force: true, recursive: true});
  }
}

async function createRemoteSnapshotWithProgress(
  context: CommandContext,
  output: string,
): Promise<string> {
  return withSpinner(
    {
      error: "Snapshot creation failed",
      start: "Preparing the portable snapshot",
      success: "Snapshot data downloaded and packaged",
    },
    (activity) => createRemoteSnapshot(context, output, activity.update),
  );
}

function assertSnapshotTableHistory(manifest: SnapshotManifest): void {
  const currentCategories = new Map<string, keyof typeof SNAPSHOT_TABLES>();
  for (const category of Object.keys(SNAPSHOT_TABLES) as Array<keyof typeof SNAPSHOT_TABLES>) {
    for (const table of SNAPSHOT_TABLES[category]) {
      currentCategories.set(table, category);
    }
  }
  for (const category of Object.keys(manifest.database.tables) as Array<keyof typeof SNAPSHOT_TABLES>) {
    for (const table of manifest.database.tables[category]) {
      const current = currentCategories.get(table);
      if (!current) {
        throw new Error(
          `Snapshot table ${table} is unknown to this checkout. Use a newer checkout.`,
        );
      }
      if (current !== category) {
        throw new Error(
          `Snapshot table ${table} changed classification from ${category} to ${current}. Historical snapshot classifications are immutable.`,
        );
      }
    }
  }
}

function snapshotApplicationTables(manifest: SnapshotManifest): string[] {
  return [
    ...manifest.database.tables.durable,
    ...manifest.database.tables.ephemeral,
    ...manifest.database.tables.targetSpecific,
  ];
}

async function repositoryIndexDefinitions(
  migrations?: readonly SnapshotMigration[],
): Promise<SnapshotIndexDefinition[]> {
  const selectedMigrations = migrations ?? await repositoryMigrations();
  const definitions = new Map<string, SnapshotIndexDefinition>();
  for (const migration of selectedMigrations) {
    const sql = await readFile(path.join(repositoryRoot, "migrations", migration.filename), "utf8");
    for (const definition of migrationIndexDefinitions(sql)) {
      definitions.set(definition.name, definition);
    }
  }
  return [...definitions.values()];
}

async function restoreSnapshotIndexes(
  cloudflare: CloudflareClient,
  config: MicrofeedConfig,
  manifest: SnapshotManifest,
  directory: string,
  options: {local?: boolean; persistTo?: string} = {},
): Promise<void> {
  const expected = await repositoryIndexDefinitions(
    manifest.database.migrations,
  );
  if (expected.length === 0) return;
  const existing = new Set(
    (await databaseIndexDefinitions(cloudflare, config, null, options))
      .map(({name}) => name),
  );
  const missing = expected.filter(({name}) => !existing.has(name));
  if (missing.length === 0) return;
  const filename = path.join(directory, "restore-indexes.sql");
  await writeFile(
    filename,
    `${missing.map(({sql}) => sql).join("\n")}\n`,
    {encoding: "utf8", mode: 0o600},
  );
  await cloudflare.executeSqlFile(config, filename, options);
}

async function verifyImportedRowCounts(
  cloudflare: CloudflareClient,
  config: MicrofeedConfig,
  manifest: SnapshotManifest,
  options: {local?: boolean; persistTo?: string} = {},
): Promise<void> {
  const durableTables = Object.keys(manifest.database.rowCounts);
  const counts = await durableRowCounts(cloudflare, config, durableTables, options);
  for (const table of durableTables) {
    if (counts[table] !== manifest.database.rowCounts[table]) {
      throw new Error(
        `Imported D1 row count for ${table} is ${counts[table]}, expected ${manifest.database.rowCounts[table]}.`,
      );
    }
  }
}

async function verifyRestoredDatabase(
  cloudflare: CloudflareClient,
  config: MicrofeedConfig,
  manifest: SnapshotManifest,
  options: {local?: boolean; persistTo?: string} = {},
): Promise<void> {
  const currentMigrations = await repositoryMigrations();
  const ledger = await migrationLedger(cloudflare, config, options);
  if (JSON.stringify(ledger) !==
      JSON.stringify(currentMigrations.map(({filename}) => filename))) {
    throw new Error("Restored D1 migration ledger does not match the current checkout.");
  }
  const tableNames = await databaseTableNames(cloudflare, config, options);
  const applications = applicationTablesFromSqlite(tableNames);
  assertClassifiedTables(applications);
  const expectedTables = [
    ...SNAPSHOT_TABLES.durable,
    ...SNAPSHOT_TABLES.ephemeral,
    ...SNAPSHOT_TABLES.targetSpecific,
  ];
  const missingTables = expectedTables.filter((table) => !applications.includes(table));
  if (missingTables.length > 0) {
    throw new Error(`Restored D1 is missing tables: ${missingTables.join(", ")}.`);
  }
  const indexRows = await cloudflare.queryD1(
    config,
    "SELECT name FROM sqlite_schema WHERE type = 'index' ORDER BY name",
    options,
  );
  const indexes = new Set(indexRows.flatMap(({name}) =>
    typeof name === "string" ? [name] : []
  ));
  const missingIndexes = (await repositoryIndexDefinitions()).map(({name}) => name)
    .filter((name) =>
    !indexes.has(name)
  );
  if (missingIndexes.length > 0) {
    throw new Error(`Restored D1 is missing indexes: ${missingIndexes.join(", ")}.`);
  }
  const foreignKeyFailures = await cloudflare.queryD1(
    config,
    "PRAGMA foreign_key_check",
    options,
  );
  if (foreignKeyFailures.length > 0) {
    throw new Error("Restored D1 failed foreign-key integrity checks.");
  }
  if ((manifest.database.rowCounts.auth_user ?? 0) > 0) {
    const owners = await cloudflare.queryD1(
      config,
      "SELECT id, email FROM auth_user ORDER BY createdAt LIMIT 1",
      options,
    );
    if (owners.length !== 1 || typeof owners[0]?.email !== "string") {
      throw new Error("Restored D1 administrator record is missing.");
    }
  }
  const [installation] = await cloudflare.queryD1(
    config,
    "SELECT instanceId FROM microfeed_installation WHERE id = 'installation'",
    options,
  );
  if (installation?.instanceId !== config.instanceId) {
    throw new Error("Restored D1 installation identity does not match its target.");
  }
}

function r2PutOptions(object: SnapshotR2Object) {
  return {
    customMetadata: object.customMetadata,
    httpMetadata: {
      ...object.httpMetadata,
      ...(object.httpMetadata.cacheExpiry
        ? {cacheExpiry: new Date(object.httpMetadata.cacheExpiry)}
        : {}),
    },
    ...(object.storageClass ? {storageClass: object.storageClass} : {}),
  };
}

function normalizedR2Metadata(input: {
  customMetadata?: Record<string, string>;
  httpMetadata?: SnapshotR2Object["httpMetadata"] | {
    cacheExpiry?: Date | string;
    [key: string]: unknown;
  };
  storageClass?: string | null;
}) {
  const customMetadata = Object.fromEntries(
    Object.entries(input.customMetadata ?? {})
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const rawHttpMetadata = input.httpMetadata ?? {};
  const httpMetadata = Object.fromEntries(
    Object.entries(rawHttpMetadata).flatMap(([key, value]) => {
      if (value === undefined) {
        return [];
      }
      if (key === "cacheExpiry") {
        return [[key, new Date(value as Date | string).toISOString()]];
      }
      return [[key, value]];
    }).sort(([left], [right]) => left.localeCompare(right)),
  );
  return {
    customMetadata,
    httpMetadata,
    storageClass: input.storageClass || "Standard",
  };
}

interface RestoredR2InventoryObject {
  customMetadata?: Record<string, string>;
  httpMetadata?: SnapshotR2Object["httpMetadata"] | {
    cacheExpiry?: Date | string;
    [key: string]: unknown;
  };
  key: string;
  size: number;
  storageClass?: string | null;
}

function snapshotValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized.length <= 500
    ? serialized
    : `${serialized.slice(0, 500)}…`;
}

export function restoredRemoteMediaMismatch(
  expectedObjects: readonly SnapshotR2Object[],
  restoredObjects: readonly RestoredR2InventoryObject[],
): string | null {
  const expectedByKey = new Map(expectedObjects.map((object) => [
    object.key,
    object,
  ]));
  const restoredByKey = new Map(restoredObjects.map((object) => [
    object.key,
    object,
  ]));
  const differences: string[] = [];
  for (const key of [...expectedByKey.keys()].sort()) {
    const expected = expectedByKey.get(key)!;
    const restored = restoredByKey.get(key);
    if (!restored) {
      differences.push(`missing object ${JSON.stringify(key)}`);
      continue;
    }
    if (restored.size !== expected.size) {
      differences.push(
        `${JSON.stringify(key)} has ${restored.size} bytes; expected ` +
          `${expected.size}`,
      );
    }
    const expectedMetadata = normalizedR2Metadata(expected);
    const restoredMetadata = normalizedR2Metadata(restored);
    if (!isDeepStrictEqual(restoredMetadata, expectedMetadata)) {
      differences.push(
        `${JSON.stringify(key)} metadata is ` +
          `${snapshotValue(restoredMetadata)}; expected ` +
          snapshotValue(expectedMetadata),
      );
    }
  }
  for (const key of [...restoredByKey.keys()].sort()) {
    if (!expectedByKey.has(key)) {
      differences.push(`unexpected object ${JSON.stringify(key)}`);
    }
  }
  if (differences.length === 0) {
    return null;
  }
  const visible = differences.slice(0, 8);
  const remaining = differences.length - visible.length;
  return [
    `Restored R2 verification found ${differences.length} difference${
      differences.length === 1 ? "" : "s"
    } (snapshot: ${expectedObjects.length} objects; restored: ` +
      `${restoredObjects.length} objects):`,
    ...visible.map((difference) => `- ${difference}`),
    ...(remaining > 0 ? [`- …and ${remaining} more`] : []),
  ].join("\n");
}

const REMOTE_MEDIA_VERIFICATION_DELAYS = [
  1_000,
  2_000,
  4_000,
  8_000,
  15_000,
  30_000,
] as const;

export async function verifyRestoredRemoteMediaWithRetries(input: {
  expected: readonly SnapshotR2Object[];
  list: () => Promise<readonly RestoredR2InventoryObject[]>;
  onRetry?: (delay: number, mismatch: string) => void;
  pause?: (milliseconds: number) => Promise<void>;
  retryDelays?: readonly number[];
}): Promise<void> {
  const pause = input.pause ?? wait;
  const retryDelays = input.retryDelays ?? REMOTE_MEDIA_VERIFICATION_DELAYS;
  for (let attempt = 0; ; attempt += 1) {
    const mismatch = restoredRemoteMediaMismatch(
      input.expected,
      await input.list(),
    );
    if (!mismatch) {
      return;
    }
    const delay = retryDelays[attempt];
    if (delay === undefined) {
      throw new Error(mismatch);
    }
    input.onRetry?.(delay, mismatch);
    await pause(delay);
  }
}

export async function restoreLocalMedia(
  config: MicrofeedConfig,
  snapshotDirectory: string,
  persistTo: string,
  objects: readonly SnapshotR2Object[],
): Promise<void> {
  const miniflare = new Miniflare({
    defaultPersistRoot: path.join(persistTo, "v3"),
    modules: true,
    r2Buckets: {MEDIA_BUCKET: config.r2.name},
    script: `export default {
      async fetch(request, env) {
        try {
          const decode = (value) => new TextDecoder().decode(
            Uint8Array.from(atob(value), (character) => character.charCodeAt(0)),
          );
          const encodedKey = request.headers.get("snapshot-key");
          const encodedOptions = request.headers.get("snapshot-r2-options");
          const key = encodedKey ? decode(encodedKey) : null;
          const options = encodedOptions
            ? JSON.parse(decode(encodedOptions))
            : null;
          if (!key || !options || !request.body) {
            return new Response("Invalid local restore request", {status: 400});
          }
          if (typeof options.httpMetadata?.cacheExpiry === "string") {
            options.httpMetadata.cacheExpiry = new Date(
              options.httpMetadata.cacheExpiry,
            );
          }
          await env.MEDIA_BUCKET.put(key, request.body, options);
          return new Response(null, {status: 204});
        } catch (error) {
          return Response.json(
            {error: error instanceof Error ? error.message : String(error)},
            {status: 500},
          );
        }
      },
    };`,
  });
  try {
    const bucket = await miniflare.getR2Bucket("MEDIA_BUCKET") as unknown as {
      head: (key: string) => Promise<{
        customMetadata?: Record<string, string>;
        httpMetadata?: Record<string, unknown>;
        size: number;
        storageClass?: string;
      } | null>;
    };
    for (const object of objects) {
      const filename = path.join(
        snapshotDirectory,
        ...object.archivePath.split("/"),
      );
      const body = Readable.toWeb(createReadStream(filename));
      const response = await miniflare.dispatchFetch("http://localhost/", {
        body,
        duplex: "half",
        headers: {
          "content-length": String(object.size),
          "snapshot-key": Buffer.from(object.key, "utf8").toString("base64"),
          "snapshot-r2-options": Buffer.from(
            JSON.stringify(r2PutOptions(object)),
            "utf8",
          ).toString("base64"),
        },
        method: "PUT",
      });
      if (!response.ok) {
        throw new Error(
          `Local R2 restore failed for ${object.key}: ${await response.text()}`,
        );
      }
      const restored = await bucket.head(object.key);
      if (!restored || restored.size !== object.size) {
        throw new Error(`Local R2 verification failed for ${object.key}.`);
      }
      const actualMetadata = normalizedR2Metadata(restored);
      const expectedMetadata = normalizedR2Metadata(object);
      if (JSON.stringify(actualMetadata) !== JSON.stringify(expectedMetadata)) {
        throw new Error(
          `Local R2 metadata verification failed for ${object.key}: ` +
            `expected ${JSON.stringify(expectedMetadata)}, received ` +
            `${JSON.stringify(actualMetadata)}.`,
        );
      }
    }
  } finally {
    await miniflare.dispose();
  }
}

async function restoreSnapshotLocally(
  archive: string,
  targetInstance: string,
  runner: CommandRunner,
  progress: (message: string) => void = () => undefined,
): Promise<{needsLoginSetup: boolean}> {
  const error = validateLocalInstanceName(targetInstance);
  if (error) {
    throw new Error(`Invalid instance name \`${targetInstance}\`. ${error}`);
  }
  const targetDirectory = instanceDirectory(targetInstance);
  const targetAlreadyExists = await stat(targetDirectory)
    .then(() => true)
    .catch((statError: unknown) => {
      if (statError instanceof Error && "code" in statError &&
          statError.code === "ENOENT") {
        return false;
      }
      throw statError;
    });
  if (targetAlreadyExists || await readConfig(false, targetInstance)) {
    throw new Error(
      `Local restore target \`${targetInstance}\` already exists. Choose a new instance name.`,
    );
  }
  const extractedDirectory = await mkdtemp(
    path.join(tmpdir(), "microfeed-snapshot-extract-"),
  );
  let createdConfig = false;
  try {
    progress("Validating the snapshot archive and migration history");
    const {manifest} = await extractSnapshotArchive(archive, extractedDirectory);
    validateSnapshotMigrations(
      manifest.database.migrations,
      await repositoryMigrations(),
    );
    assertSnapshotTableHistory(manifest);
    progress("Preparing the new local instance");
    const config = await ensureLocalOnlyConfig(targetInstance);
    createdConfig = true;
    const temporaryPersistence = path.join(
      instanceDirectory(targetInstance),
      `.snapshot-restore-${randomUUID()}`,
    );
    await mkdir(temporaryPersistence, {recursive: true});
    try {
      const schemaSql = await readFile(
        path.join(extractedDirectory, manifest.database.schema.path),
        "utf8",
      );
      const dataSql = await readFile(
        path.join(extractedDirectory, manifest.database.data.path),
        "utf8",
      );
      const restoreSqlPath = path.join(extractedDirectory, "restore.sql");
      await writeFile(restoreSqlPath, buildRestoreSql({
        currentApplicationTables: [],
        dataSql,
        schemaSql,
        snapshotApplicationTables: snapshotApplicationTables(manifest),
      }), {encoding: "utf8", mode: 0o600});
      progress("Importing the snapshot D1 schema and durable data");
      await new CloudflareClient(runner).executeSqlFile(
        config,
        restoreSqlPath,
        {local: true, persistTo: temporaryPersistence},
      );
      const cloudflare = new CloudflareClient(runner);
      progress("Verifying imported D1 row counts");
      await verifyImportedRowCounts(cloudflare, config, manifest, {
        local: true,
        persistTo: temporaryPersistence,
      });
      progress("Restoring historical D1 indexes");
      await restoreSnapshotIndexes(
        cloudflare,
        config,
        manifest,
        extractedDirectory,
        {local: true, persistTo: temporaryPersistence},
      );
      progress("Applying newer D1 migrations");
      await cloudflare.applyLocalMigrations(config, temporaryPersistence);
      await prepareItemSearch(cloudflare, config, {
        local: true,
        persistTo: temporaryPersistence,
      });
      const finalizationSqlPath = path.join(
        extractedDirectory,
        "finalize.sql",
      );
      await writeFile(
        finalizationSqlPath,
        buildRestoreFinalizationSql(config.instanceId),
        {encoding: "utf8", mode: 0o600},
      );
      progress("Recreating local installation state");
      await cloudflare.executeSqlFile(config, finalizationSqlPath, {
        local: true,
        persistTo: temporaryPersistence,
      });
      progress(
        manifest.media.objectCount === 0
          ? "The snapshot has no R2 media to restore"
          : `Restoring ${manifest.media.objectCount} R2 media ${
            manifest.media.objectCount === 1 ? "object" : "objects"
          } locally`,
      );
      await restoreLocalMedia(
        config,
        extractedDirectory,
        temporaryPersistence,
        manifest.media.objects,
      );
      progress("Verifying the restored local D1 and R2 data");
      await verifyRestoredDatabase(cloudflare, config, manifest, {
        local: true,
        persistTo: temporaryPersistence,
      });
      progress("Activating the restored local instance");
      const finalPersistence = localPersistencePath(config);
      await rename(temporaryPersistence, finalPersistence);
      markStep(config, "migrations-applied");
      markStep(config, "snapshot-restored");
      markStep(config, "initialization-complete");
      await writeConfig(config);
      await setActiveInstance(targetInstance);
      return {
        needsLoginSetup: (manifest.database.rowCounts.auth_user ?? 0) === 0,
      };
    } catch (restoreError) {
      await rm(temporaryPersistence, {force: true, recursive: true});
      throw restoreError;
    }
  } catch (restoreError) {
    if (createdConfig) {
      await removeSavedInstance(targetInstance);
    }
    throw restoreError;
  } finally {
    await rm(extractedDirectory, {force: true, recursive: true});
  }
}

async function restoreSnapshotLocallyWithProgress(
  archive: string,
  targetInstance: string,
  runner: CommandRunner,
): Promise<{needsLoginSetup: boolean}> {
  return withSpinner(
    {
      error: "Local snapshot restore failed",
      start: "Preparing the local snapshot restore",
      success: "Snapshot data restored and verified locally",
    },
    (activity) =>
      restoreSnapshotLocally(
        archive,
        targetInstance,
        runner,
        activity.update,
      ),
  );
}

const SNAPSHOT_RESTORE_ENDPOINT = "/__microfeed_snapshot_restore/v1";

export function maintenanceWorkerSource(): string {
  return `
function bytesFromHex(value) {
  if (!/^[a-f0-9]{64}$/.test(value)) return null;
  return Uint8Array.from(value.match(/../g), (byte) => Number.parseInt(byte, 16));
}
async function authorized(request, expectedHex) {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const actual = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const expected = bytesFromHex(expectedHex);
  if (!expected || actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual[index] ^ expected[index];
  return difference === 0;
}
function validMetadata(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}
function normalizedOptions(value) {
  const options = {...value};
  if (validMetadata(value.httpMetadata)) {
    options.httpMetadata = {...value.httpMetadata};
    if (typeof options.httpMetadata.cacheExpiry === "string") {
      options.httpMetadata.cacheExpiry = new Date(options.httpMetadata.cacheExpiry);
    }
  }
  return options;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== ${JSON.stringify(SNAPSHOT_RESTORE_ENDPOINT)} ||
        !await authorized(request, env.SNAPSHOT_TOKEN_HASH)) {
      return new Response("Snapshot restoration is in progress.", {
        status: 503,
        headers: {"cache-control": "no-store", "retry-after": "60"},
      });
    }
    if (request.method === "GET") return Response.json({maintenance: true});
    const action = url.searchParams.get("action");
    try {
      if (action === "create" && request.method === "POST") {
        const input = await request.json();
        if (typeof input.key !== "string" || !input.key || !validMetadata(input.options)) {
          return new Response("Invalid multipart metadata.", {status: 400});
        }
        const upload = await env.MEDIA_BUCKET.createMultipartUpload(
          input.key,
          normalizedOptions(input.options),
        );
        return Response.json({uploadId: upload.uploadId});
      }
      if (action === "part" && request.method === "PUT") {
        const key = url.searchParams.get("key");
        const uploadId = url.searchParams.get("uploadId");
        const partNumber = Number(url.searchParams.get("partNumber"));
        if (!key || !uploadId || !Number.isInteger(partNumber) || partNumber < 1 || !request.body) {
          return new Response("Invalid multipart part.", {status: 400});
        }
        const part = await env.MEDIA_BUCKET.resumeMultipartUpload(key, uploadId)
          .uploadPart(partNumber, request.body);
        return Response.json(part);
      }
      if (action === "complete" && request.method === "POST") {
        const input = await request.json();
        if (typeof input.key !== "string" || typeof input.uploadId !== "string" ||
            !Array.isArray(input.parts)) {
          return new Response("Invalid multipart completion.", {status: 400});
        }
        const object = await env.MEDIA_BUCKET.resumeMultipartUpload(input.key, input.uploadId)
          .complete(input.parts);
        return Response.json({etag: object.etag, size: object.size});
      }
      if (action === "abort" && request.method === "POST") {
        const input = await request.json();
        if (typeof input.key !== "string" || typeof input.uploadId !== "string") {
          return new Response("Invalid multipart abort.", {status: 400});
        }
        await env.MEDIA_BUCKET.resumeMultipartUpload(input.key, input.uploadId)
          .abort();
        return Response.json({aborted: true});
      }
      if (action === "empty" && request.method === "PUT") {
        const input = await request.json();
        if (typeof input?.key !== "string" || !validMetadata(input.options)) {
          return new Response("Invalid empty object metadata.", {status: 400});
        }
        const object = await env.MEDIA_BUCKET.put(
          input.key,
          new Uint8Array(),
          normalizedOptions(input.options),
        );
        return Response.json({etag: object.etag, size: object.size});
      }
      return new Response("Unsupported snapshot action.", {status: 400});
    } catch (error) {
      return Response.json({error: error instanceof Error ? error.message : String(error)}, {status: 500});
    }
  },
};\n`;
}

export function snapshotMaintenanceRouting(config: MicrofeedConfig): {
  preview_urls: false;
  routes: Array<{custom_domain: true; pattern: string}>;
  workers_dev: true;
} {
  return {
    preview_urls: false,
    routes: config.customDomain
      ? [{custom_domain: true, pattern: config.customDomain}]
      : [],
    workers_dev: true,
  };
}

export function snapshotWorkerErrorDetail(
  body: string,
  contentType: string | null,
): string {
  const normalized = body.trim().replaceAll(/\s+/gu, " ");
  if (contentType?.toLowerCase().includes("text/html")) {
    const title = body.match(/<title[^>]*>([^<]+)<\/title>/iu)?.[1]?.trim();
    return title
      ? `Cloudflare returned an HTML page titled \`${title}\` instead of ` +
        "the maintenance API."
      : "Cloudflare returned an HTML page instead of the maintenance API.";
  }
  if (!normalized) return "No error detail was returned.";
  const maximumLength = 600;
  return normalized.length <= maximumLength
    ? normalized
    : `${normalized.slice(0, maximumLength)}…`;
}

async function deployMaintenanceWorker(
  context: CommandContext,
  config: MicrofeedConfig,
  temporaryDirectory: string,
  token: string,
): Promise<string> {
  if (!config.deploymentUrl) {
    throw new Error("The restore target has no deployment URL.");
  }
  const sourcePath = path.join(temporaryDirectory, "maintenance-worker.js");
  const configPath = path.join(temporaryDirectory, "maintenance-wrangler.json");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await writeFile(sourcePath, maintenanceWorkerSource(), {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(configPath, `${JSON.stringify({
    account_id: cloudflareAccountId(config),
    compatibility_date: "2026-07-29",
    compatibility_flags: ["nodejs_compat"],
    main: sourcePath,
    name: workerName(config),
    observability: {enabled: false},
    r2_buckets: [{binding: "MEDIA_BUCKET", bucket_name: config.r2.name}],
    ...snapshotMaintenanceRouting(config),
    vars: {SNAPSHOT_TOKEN_HASH: tokenHash},
  }, null, 2)}\n`, {encoding: "utf8", mode: 0o600});
  await context.cloudflare.deployWithConfig(config, configPath);
  return new URL(SNAPSHOT_RESTORE_ENDPOINT, config.deploymentUrl).href;
}

async function snapshotWorkerRequest(
  endpoint: string,
  token: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(endpoint, {
    ...init,
    headers: {authorization: `Bearer ${token}`, ...init.headers},
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Snapshot maintenance Worker at ${endpoint} returned HTTP ` +
        `${response.status}. ${snapshotWorkerErrorDetail(
          body,
          response.headers.get("content-type"),
        )}`,
    );
  }
  return body ? JSON.parse(body) as Record<string, unknown> : {};
}

async function waitForSnapshotWorker(
  endpoint: string,
  token: string,
): Promise<void> {
  let lastError: unknown;
  for (const delay of [0, 1_000, 2_000, 4_000, 8_000]) {
    if (delay > 0) {
      await wait(delay);
    }
    try {
      await snapshotWorkerRequest(endpoint, token, {method: "GET"});
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function uploadRemoteObject(
  endpoint: string,
  token: string,
  snapshotDirectory: string,
  object: SnapshotR2Object,
): Promise<void> {
  const filename = path.join(snapshotDirectory, ...object.archivePath.split("/"));
  const options = r2PutOptions(object);
  if (object.size === 0) {
    const url = new URL(endpoint);
    url.searchParams.set("action", "empty");
    await snapshotWorkerRequest(url.href, token, {
      body: JSON.stringify({key: object.key, options}),
      headers: {"content-type": "application/json"},
      method: "PUT",
    });
    return;
  }
  const createUrl = new URL(endpoint);
  createUrl.searchParams.set("action", "create");
  const created = await snapshotWorkerRequest(createUrl.href, token, {
    body: JSON.stringify({key: object.key, options}),
    headers: {"content-type": "application/json"},
    method: "POST",
  });
  const uploadId = created.uploadId;
  if (typeof uploadId !== "string" || !uploadId) {
    throw new Error(`Maintenance Worker did not create an upload for ${object.key}.`);
  }
  const minimumPartSize = 8 * 1024 * 1024;
  const partSize = Math.max(
    minimumPartSize,
    Math.ceil(object.size / 9_999),
  );
  try {
    const parts: Array<{etag: string; partNumber: number}> = [];
    for (let start = 0, partNumber = 1; start < object.size;
         start += partSize, partNumber += 1) {
      const end = Math.min(start + partSize, object.size) - 1;
      const partUrl = new URL(endpoint);
      partUrl.searchParams.set("action", "part");
      partUrl.searchParams.set("key", object.key);
      partUrl.searchParams.set("uploadId", uploadId);
      partUrl.searchParams.set("partNumber", String(partNumber));
      const response = await snapshotWorkerRequest(partUrl.href, token, {
        body: createReadStream(filename, {end, start}) as never,
        headers: {"content-length": String(end - start + 1)},
        method: "PUT",
        // Node requires duplex for streamed fetch request bodies.
        ...({duplex: "half"} as Record<string, unknown>),
      });
      if (typeof response.etag !== "string") {
        throw new Error(`Maintenance Worker did not accept part ${partNumber} of ${object.key}.`);
      }
      parts.push({etag: response.etag, partNumber});
    }
    const completeUrl = new URL(endpoint);
    completeUrl.searchParams.set("action", "complete");
    await snapshotWorkerRequest(completeUrl.href, token, {
      body: JSON.stringify({key: object.key, parts, uploadId}),
      headers: {"content-type": "application/json"},
      method: "POST",
    });
  } catch (error) {
    const abortUrl = new URL(endpoint);
    abortUrl.searchParams.set("action", "abort");
    await snapshotWorkerRequest(abortUrl.href, token, {
      body: JSON.stringify({key: object.key, uploadId}),
      headers: {"content-type": "application/json"},
      method: "POST",
    }).catch(() => undefined);
    throw error;
  }
}

async function verifyRestoredRemoteMedia(
  cloudflare: CloudflareClient,
  config: MicrofeedConfig,
  objects: readonly SnapshotR2Object[],
  onRetry?: (delay: number) => void,
): Promise<void> {
  await verifyRestoredRemoteMediaWithRetries({
    expected: objects,
    list: () => cloudflare.listR2Objects(
      cloudflareAccountId(config),
      config.r2.name,
    ),
    onRetry: (delay) => onRetry?.(delay),
  });
}

export interface SnapshotRestoreJournal {
  accountId: string;
  archiveSha256: string;
  databaseId: string;
  instanceId: string;
  r2BucketName: string;
  stage: string;
  startedAt: string;
}

function restoreJournalPath(config: MicrofeedConfig): string {
  return path.join(instanceDirectory(config.instanceName), "snapshot-restore.json");
}

async function readRestoreJournal(
  config: MicrofeedConfig,
): Promise<SnapshotRestoreJournal | null> {
  try {
    return JSON.parse(await readFile(restoreJournalPath(config), "utf8")) as
      SnapshotRestoreJournal;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeRestoreJournal(
  config: MicrofeedConfig,
  journal: SnapshotRestoreJournal,
): Promise<void> {
  await writeFile(
    restoreJournalPath(config),
    `${JSON.stringify(journal, null, 2)}\n`,
    {encoding: "utf8", mode: 0o600},
  );
}

export function validateRestoreJournal(
  journal: SnapshotRestoreJournal,
  config: MicrofeedConfig,
  archiveSha256: string,
): void {
  if (
    journal.archiveSha256 !== archiveSha256 ||
    journal.accountId !== cloudflareAccountId(config) ||
    journal.databaseId !== config.d1.id ||
    journal.instanceId !== config.instanceId ||
    journal.r2BucketName !== config.r2.name
  ) {
    throw new Error(
      "A different snapshot restore is already in progress for this target. Resume it with the same archive before starting another restore.",
    );
  }
}

async function restoreSnapshotRemotely(
  context: CommandContext,
  archive: string,
): Promise<{needsLoginSetup: boolean}> {
  const extractedDirectory = await mkdtemp(
    path.join(tmpdir(), "microfeed-snapshot-remote-"),
  );
  try {
    const {manifest, pending} = await withSpinner(
      {
        error: "Snapshot archive validation failed",
        start: "Validating the snapshot archive and checksums",
        success: "Snapshot archive is valid; checking the restore target next",
      },
      async (activity) => {
        const {manifest} = await extractSnapshotArchive(
          archive,
          extractedDirectory,
        );
        activity.update("Comparing the snapshot and repository migrations");
        const currentMigrations = await repositoryMigrations();
        const {pending} = validateSnapshotMigrations(
          manifest.database.migrations,
          currentMigrations,
        );
        assertSnapshotTableHistory(manifest);
        return {manifest, pending};
      },
    );
    const config = await ensureWranglerConfig(false, false, context.instanceName);
    if (flagBoolean(context.flags, "yes")) {
      throw new Error("Remote snapshot restore does not support --yes.");
    }
    const accountId = cloudflareAccountId(config);
    let readinessError = remoteRestoreTargetReadinessError(config);
    if (readinessError && !canRepairRemoteRestoreBaseline(config)) {
      throw new Error(readinessError);
    }
    if (
      readinessError &&
      !flagBoolean(context.flags, "dry-run")
    ) {
      throw new Error(
        `${readinessError} Run the restore with \`--dry-run\` first so the ` +
          "CLI can perform and record the read-only freshness checks.",
      );
    }
    const account = await authenticate(context, accountId);
    if (account.id !== accountId) {
      throw new Error(`This installation belongs to Cloudflare account ${accountId}.`);
    }
    if (readinessError) {
      await repairRemoteRestoreBaseline(context, config);
      readinessError = remoteRestoreTargetReadinessError(config);
      if (readinessError) {
        throw new Error(readinessError);
      }
    }
    const restoreBaseline = config.restoreBaseline!;
    const {
      archiveSha256,
      existingJournal,
      previousMediaMismatch,
      targetFingerprintRefreshed,
    } =
      await withSpinner(
      {
        error: "Remote restore target validation failed",
        start: "Checking the snapshot and fresh remote target",
        success: "Fresh remote restore target validated",
      },
      async (activity) => {
        const archiveSha256 = await sha256File(archive);
        const existingJournal = await readRestoreJournal(config);
        let targetFingerprintRefreshed = false;
        if (existingJournal) {
          validateRestoreJournal(existingJournal, config, archiveSha256);
        } else {
          activity.update("Verifying the remote D1 initialization fingerprint");
          const currentFingerprint = await remoteRestoreFingerprint(
            context.cloudflare,
            config,
          );
          targetFingerprintRefreshed =
            await reverifyRemoteRestoreTargetIfFingerprintChanged({
              currentFingerprint,
              expectedFingerprint: restoreBaseline.fingerprint,
              reverify: async () => {
                activity.update(
                  "The saved fingerprint changed; proving the target is still fresh",
                );
                await assertFreshRemoteRestoreTarget(
                  context,
                  config,
                  activity,
                );
                await saveVerifiedRemoteRestoreBaseline(
                  context,
                  config,
                  activity,
                );
              },
            });
          activity.update("Verifying the remote R2 bucket is empty");
          const existingObjects = await context.cloudflare.listR2Objects(
            accountId,
            config.r2.name,
          );
          if (existingObjects.length > 0) {
            throw new Error("The remote restore target's R2 bucket is not empty.");
          }
        }
        let previousMediaMismatch: string | null | undefined;
        if (existingJournal?.stage === "media-restored") {
          activity.update("Checking media from the previous restore attempt");
          previousMediaMismatch = restoredRemoteMediaMismatch(
            manifest.media.objects,
            await context.cloudflare.listR2Objects(
              accountId,
              config.r2.name,
            ),
          );
        }
        return {
          archiveSha256,
          existingJournal,
          previousMediaMismatch,
          targetFingerprintRefreshed,
        };
      },
    );
    prompts.note([
      `Target instance: ${config.instanceName}`,
      `D1 database: ${config.d1.name} (${config.d1.id})`,
      `R2 bucket: ${config.r2.name}`,
      `Snapshot source: ${manifest.source.instanceName}`,
      `Snapshot migrations: ${manifest.database.migrations.length}`,
      `Pending migrations: ${pending.length}`,
      `R2 objects: ${manifest.media.objectCount}`,
      `Mode: ${existingJournal ? "resume from archived source state" : "fresh restore"}`,
      ...(targetFingerprintRefreshed
        ? ["Target check: saved fingerprint changed; full freshness checks passed"]
        : []),
      ...(previousMediaMismatch === undefined
        ? []
        : [
          `Previous media upload: ${previousMediaMismatch
            ? "differences found; see details below"
            : "matches the snapshot"}`,
        ]),
    ].join("\n"), "Snapshot restore plan");
    if (previousMediaMismatch) {
      prompts.note(
        previousMediaMismatch,
        "Previous media restore differences",
      );
    }
    if (flagBoolean(context.flags, "dry-run")) {
      prompts.outro(
        `Dry run complete. Restore with \`--confirm ${config.instanceName}\`.`,
      );
      return {
        needsLoginSetup: (manifest.database.rowCounts.auth_user ?? 0) === 0,
      };
    }
    if (flagString(context.flags, "confirm") !== config.instanceName) {
      throw new Error(
        `Remote restore requires \`--confirm ${config.instanceName}\` after reviewing the dry run.`,
      );
    }
    const journal: SnapshotRestoreJournal = existingJournal ?? {
      accountId,
      archiveSha256,
      databaseId: config.d1.id,
      instanceId: config.instanceId,
      r2BucketName: config.r2.name,
      stage: "validated",
      startedAt: new Date().toISOString(),
    };
    await writeRestoreJournal(config, journal);
    try {
      await withSpinner(
        {
          error: "Remote snapshot data restore failed",
          start: "Putting the remote target into maintenance mode",
          success: "Remote snapshot data restored and verified",
        },
        async (activity) => {
          const token = randomBytes(32).toString("base64url");
          const endpoint = await deployMaintenanceWorker(
            context,
            config,
            extractedDirectory,
            token,
          );
          activity.update("Waiting for the maintenance Worker to become ready");
          await waitForSnapshotWorker(endpoint, token);
          journal.stage = "maintenance";
          await writeRestoreJournal(config, journal);

          activity.update("Importing the snapshot D1 schema and durable data");
          const currentTables = applicationTablesFromSqlite(
            await databaseTableNames(context.cloudflare, config),
          );
          const restoreSqlPath = path.join(extractedDirectory, "restore.sql");
          await writeFile(restoreSqlPath, buildRestoreSql({
            currentApplicationTables: currentTables,
            dataSql: await readFile(
              path.join(extractedDirectory, manifest.database.data.path),
              "utf8",
            ),
            schemaSql: await readFile(
              path.join(extractedDirectory, manifest.database.schema.path),
              "utf8",
            ),
            snapshotApplicationTables: snapshotApplicationTables(manifest),
          }), {encoding: "utf8", mode: 0o600});
          await dropItemSearchIndexes(context.cloudflare, config);
          await context.cloudflare.executeSqlFile(config, restoreSqlPath);
          activity.update("Verifying imported D1 row counts and indexes");
          await verifyImportedRowCounts(context.cloudflare, config, manifest);
          await restoreSnapshotIndexes(
            context.cloudflare,
            config,
            manifest,
            extractedDirectory,
          );
          journal.stage = "database-imported";
          await writeRestoreJournal(config, journal);
          activity.update("Applying newer D1 migrations");
          await context.cloudflare.applyMigrations(config);
          await prepareItemSearch(context.cloudflare, config);
          const finalizationSqlPath = path.join(
            extractedDirectory,
            "finalize.sql",
          );
          await writeFile(
            finalizationSqlPath,
            buildRestoreFinalizationSql(config.instanceId),
            {encoding: "utf8", mode: 0o600},
          );
          activity.update("Recreating target-specific installation state");
          await context.cloudflare.executeSqlFile(config, finalizationSqlPath);
          journal.stage = "migrations-applied";
          await writeRestoreJournal(config, journal);

          activity.update("Preparing the remote R2 media restore");
          await context.cloudflare.emptyR2Bucket(accountId, config.r2.name);
          for (const [index, object] of manifest.media.objects.entries()) {
            activity.update(
              `Restoring R2 media: object ${index + 1} of ${
                manifest.media.objectCount
              }`,
            );
            await uploadRemoteObject(
              endpoint,
              token,
              extractedDirectory,
              object,
            );
          }
          journal.stage = "media-restored";
          await writeRestoreJournal(config, journal);
          activity.update("Verifying the restored remote D1 and R2 data");
          await verifyRestoredDatabase(context.cloudflare, config, manifest);
          await verifyRestoredRemoteMedia(
            context.cloudflare,
            config,
            manifest.media.objects,
            (delay) => activity.update(
              "Waiting for Cloudflare's R2 inventory to reflect the " +
                `completed uploads; checking again in ${
                  Math.ceil(delay / 1_000)
                }s`,
            ),
          );
          journal.stage = "verified";
          await writeRestoreJournal(config, journal);
        },
      );

      await deployConfiguredProject(context, config, false);
      markStep(config, "snapshot-restored");
      await writeConfig(config);
      await unlink(restoreJournalPath(config));
    } catch (error) {
      throw new Error(
        `${errorMessage(error)}\n\nThe target remains in maintenance mode. ` +
          `Fix the cause and rerun the same command with the same archive and ` +
          `\`--confirm ${config.instanceName}\`; it will restart from the archived schema and data.`,
      );
    }
    return {
      needsLoginSetup: (manifest.database.rowCounts.auth_user ?? 0) === 0,
    };
  } finally {
    await rm(extractedDirectory, {force: true, recursive: true});
  }
}

export async function snapshotCommand(
  flags: Flags,
  runner: CommandRunner = runCommand,
): Promise<void> {
  const action = flagString(flags, "action");
  if (!action || !["create", "pull", "restore"].includes(action)) {
    throw new Error(
      "Snapshot action must be create, pull, or restore. Run `yarn manage help snapshot`.",
    );
  }
  if (flagBoolean(flags, "preview")) {
    throw new Error("Portable snapshots support production instances only.");
  }
  const context: CommandContext = {
    cloudflare: new CloudflareClient(runner),
    flags,
    instanceName: undefined,
    runner,
  };
  if (action === "create") {
    if (flagBoolean(flags, "local")) {
      throw new Error("Snapshot create exports a Cloudflare instance; remove --local.");
    }
    await resolveCommandInstance(context);
    const output = snapshotOutputPath(flags, context.instanceName!);
    prompts.intro("Create portable microfeed snapshot");
    await createRemoteSnapshotWithProgress(context, output);
    prompts.outro(snapshotCreatedMessage(output));
    return;
  }
  if (action === "pull") {
    if (flagBoolean(flags, "local")) {
      throw new Error("Snapshot pull already creates a local target; remove --local.");
    }
    await resolveCommandInstance(context);
    const localInstance = flagString(flags, "local-instance");
    if (!localInstance) {
      throw new Error("Snapshot pull requires --local-instance <new-name>.");
    }
    const requestedOutput = flagString(flags, "output");
    const temporaryDirectory = requestedOutput
      ? null
      : await mkdtemp(path.join(tmpdir(), "microfeed-snapshot-pull-"));
    const output = requestedOutput
      ? path.resolve(requestedOutput)
      : path.join(temporaryDirectory!, "snapshot.tar.gz");
    prompts.intro("Pull Cloudflare instance into a local snapshot");
    let restoreResult!: {needsLoginSetup: boolean};
    try {
      await createRemoteSnapshotWithProgress(context, output);
      restoreResult = await restoreSnapshotLocallyWithProgress(
        output,
        localInstance,
        runner,
      );
    } finally {
      if (temporaryDirectory) {
        await rm(temporaryDirectory, {force: true, recursive: true});
      }
    }
    prompts.outro(
      `Local instance ${localInstance} is ready.\n\n` +
        localSnapshotNextSteps(
          localInstance,
          restoreResult.needsLoginSetup,
        ),
    );
    return;
  }
  const archive = flagString(flags, "file");
  if (!archive) {
    throw new Error("Snapshot restore requires --file <backup.tar.gz>.");
  }
  const resolvedArchive = path.resolve(archive);
  await stat(resolvedArchive).catch(() => {
    throw new Error(`Snapshot file was not found: ${resolvedArchive}.`);
  });
  if (flagBoolean(flags, "local")) {
    if (flagBoolean(flags, "dry-run") || flags.confirm !== undefined) {
      throw new Error("--dry-run and --confirm apply only to remote snapshot restore.");
    }
    const targetInstance = flagString(flags, "instance");
    if (!targetInstance) {
      throw new Error("Local snapshot restore requires --instance <new-name>.");
    }
    prompts.intro("Restore portable snapshot locally");
    const restoreResult = await restoreSnapshotLocallyWithProgress(
      resolvedArchive,
      targetInstance,
      runner,
    );
    prompts.outro(
      "Local restore complete.\n\n" +
        localSnapshotNextSteps(
          targetInstance,
          restoreResult.needsLoginSetup,
        ),
    );
    return;
  }
  if (flagBoolean(flags, "dry-run") && flags.confirm !== undefined) {
    throw new Error("Use either --dry-run or --confirm for remote restore, not both.");
  }
  await resolveCommandInstance(context);
  prompts.intro("Restore portable snapshot to Cloudflare");
  const restoreResult = await restoreSnapshotRemotely(
    context,
    resolvedArchive,
  );
  if (!flagBoolean(flags, "dry-run")) {
    prompts.outro(remoteSnapshotNextSteps(
      context.instanceName!,
      restoreResult.needsLoginSetup,
    ));
  }
}

