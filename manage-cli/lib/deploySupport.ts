/**
 * Helpers shared by the management CLI command modules.
 *
 * These were extracted from commands.ts so that snapshot.ts can use them
 * without importing commands.ts, which would create a cycle: commands.ts
 * imports two restore helpers back from snapshot.ts.
 */

import {
  createHash,
  randomBytes,
} from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";


import {
  adminUrl,
} from "@/shared/AdminPath";

import type {Account, CommandRunner, MicrofeedConfig} from "../types";
import {
  clearPasswordSetupSql,
  normalizeOwnerEmail,
  ownerInsertSql,
  validateOwnerEmail,
  validateOwnerPassword,
} from "../lib/auth";
import {
  adminAuthMode,
  cloudflareAccountId,
  defaultLocalInstance,
  generateWranglerConfig,
  listLocalInstances,
  markStep,
  validateLocalInstanceName,
  webhookProvisioned,
  wranglerConfigPath,
  writeConfig,
} from "../lib/config";
import {
  CloudflareClient,
} from "../lib/cloudflare";
import {
  relativePathFromDirectory,
  repositoryCommitSha,
  repositoryRoot,
  runYarnScript,
} from "../lib/process";
import {verifyBundledThemeReleases} from "../lib/bundled-theme-release";
import {
  askConfirm,
  askText,
  chooseAccount,
  chooseAdminAuthSetup,
  chooseLocalInstance,
  prompts,
  type WaitActivity,
  withSpinner,
} from "../lib/prompts";

import {
  applicationTablesFromSqlite,
  assertClassifiedTables,
  type SnapshotIndexDefinition,
  SNAPSHOT_TABLES,
} from "../lib/snapshot";
import {
  prepareItemSearch,
  setItemSearchReady,
} from "../lib/item-search";
export function flagString(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}


export function flagBoolean(flags: Flags, name: string): boolean {
  return flags[name] === true;
}


export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


export async function resolveCommandInstance(
  context: CommandContext,
  allowMissing = false,
): Promise<string | undefined> {
  if (context.instanceName) {
    return context.instanceName;
  }
  const requested = flagString(context.flags, "instance") ??
    process.env.MICROFEED_INSTANCE;
  if (requested) {
    const error = validateLocalInstanceName(requested);
    if (error) {
      throw new Error(`Invalid instance name \`${requested}\`. ${error}`);
    }
    context.instanceName = requested;
    return requested;
  }
  const selected = await defaultLocalInstance();
  if (selected) {
    context.instanceName = selected;
    return selected;
  }
  const instances = await listLocalInstances();
  if (instances.length > 1) {
    if (flagBoolean(context.flags, "yes")) {
      throw new Error(
        "Multiple local microfeed instances are configured. Pass " +
          "`--instance <name>` or run `yarn manage use <name>`.",
      );
    }
    context.instanceName = await chooseLocalInstance(instances);
    return context.instanceName;
  }
  if (allowMissing) {
    return undefined;
  }
  throw new Error(
    "No saved microfeed instance is configured. Run " +
      "`yarn manage init --local --instance <name>` for local development, " +
      "or `yarn manage init --instance <name>` for Cloudflare.",
  );
}


export async function authenticate(
  context: CommandContext,
  requiredAccountId?: string,
): Promise<Account> {
  let accounts = await context.cloudflare.accounts();
  const hasRequiredScopes = accounts.length > 0 &&
    await context.cloudflare.hasRequiredScopes();
  if (accounts.length === 0 || !hasRequiredScopes) {
    prompts.note(
      "microfeed requests account:read, user:read, workers:write, " +
      "workers_scripts:write, d1:write, pages:write, and zone:read. " +
      "workers_scripts:write is required to safely check and deploy the " +
      "selected Worker name. pages:write is requested only because Wrangler " +
      "does not expose a pages:read OAuth scope. microfeed only lists Pages " +
      "projects and never changes or deletes them. Queue permission is " +
      "requested only when a command enables, disables, verifies, connects, " +
      "or destroys provisioned webhook infrastructure.",
      "Cloudflare authorization",
    );
    await context.cloudflare.login({
      device: flagBoolean(context.flags, "device"),
    });
    accounts = await context.cloudflare.accounts();
  }
  if (accounts.length === 0) {
    throw new Error("Wrangler did not return any Cloudflare accounts.");
  }
  if (!await context.cloudflare.hasRequiredScopes()) {
    throw new Error(
      "Wrangler login did not grant all required microfeed OAuth scopes.",
    );
  }
  context.cloudflareLoginEmail = context.cloudflare.loginEmail() ?? undefined;
  const flaggedAccountId = flagString(context.flags, "account-id");
  if (
    requiredAccountId &&
    flaggedAccountId &&
    flaggedAccountId !== requiredAccountId
  ) {
    throw new Error(
      `This microfeed is saved under Cloudflare account ${
        requiredAccountId
      }, not ${flaggedAccountId}. No Cloudflare resources were changed.`,
    );
  }
  const requestedAccountId = requiredAccountId ?? flaggedAccountId;
  if (requestedAccountId) {
    const account = accounts.find(({id}) => id === requestedAccountId);
    if (!account) {
      throw new Error(
        `Cloudflare account ${requestedAccountId} is not available to the ` +
          "current login. No Cloudflare resources were changed. Run " +
          "`yarn manage accounts --reauthorize`, then try again.",
      );
    }
    return account;
  }
  if (flagBoolean(context.flags, "yes") && accounts.length > 1) {
    throw new Error(
      "Multiple Cloudflare accounts are available. Run `yarn manage " +
        "accounts` and pass the chosen full ID as `--account-id <id>`. " +
        "No Cloudflare resources were changed.",
    );
  }
  return chooseAccount(accounts);
}


export function hasCompletedCloudflareInitialization(
  config: MicrofeedConfig,
): boolean {
  return COMPLETED_CLOUDFLARE_INIT_STEPS.every((step) =>
    config.completedSteps.includes(step)
  );
}


export function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}


export async function verifyDeployment(
  config: MicrofeedConfig | null,
  baseUrl: string,
  options: DeploymentVerificationOptions = {},
): Promise<void> {
  const retryDelaysMs = DEPLOYMENT_VERIFICATION_RETRY_DELAYS_MS;
  const identityUrl = new URL("/.well-known/microfeed.json", baseUrl);
  let lastError: unknown;

  for (
    let attemptIndex = 0;
    attemptIndex <= retryDelaysMs.length;
    attemptIndex += 1
  ) {
    try {
      const usedDnsOverHttps = await verifyDeploymentOnce(
        config,
        baseUrl,
        options,
      );
      const retrySummary = attemptIndex > 0
        ? ` after ${attemptIndex} ${
          attemptIndex === 1 ? "retry" : "retries"
        }`
        : "";
      const dnsSummary = usedDnsOverHttps
        ? " using Cloudflare DNS over HTTPS because system DNS has not " +
          "caught up"
        : "";
      prompts.log.success(
        `✅ Deployment verified at ${identityUrl.href}${retrySummary}` +
          `${dnsSummary}.`,
      );
      return;
    } catch (error) {
      lastError = error;
      const detail = verificationErrorDetail(error, identityUrl.hostname);
      if (attemptIndex === retryDelaysMs.length) {
        break;
      }

      const delayMs = retryDelaysMs[attemptIndex]!;
      const delaySeconds = Math.round(delayMs / 1_000);
      prompts.log.warn(
        `Deployment verification attempt ${attemptIndex + 1} failed for ` +
          `${identityUrl.href}: ${detail}.`,
      );
      prompts.log.info(
        (
          config?.customDomain
            ? "Custom-domain DNS caches or TLS certificate provisioning " +
              "may still be catching up. "
            : "The deployment endpoint may still be becoming available. "
        ) +
          `Retrying in ${delaySeconds} seconds ` +
          `(retry ${attemptIndex + 1} of ${retryDelaysMs.length}).`,
      );
      await wait(delayMs);
    }
  }

  const totalWaitSeconds = Math.round(
    retryDelaysMs.reduce((total, delay) => total + delay, 0) / 1_000,
  );
  const attempts = retryDelaysMs.length + 1;
  const lastDetail = verificationErrorDetail(
    lastError,
    identityUrl.hostname,
  );
  const targetLabel = config?.customDomain
    ? "custom domain"
    : "deployment URL";
  const provisioningMessage = config?.customDomain
    ? "DNS resolution or Cloudflare TLS certificate provisioning may still " +
      "be catching up."
    : "The deployment endpoint may still be becoming available.";
  throw new Error(
    `The Worker was deployed, but its ${targetLabel} could not be verified ` +
      `after ${attempts} attempts over about ${totalWaitSeconds} seconds.\n` +
      `${provisioningMessage}\n` +
      `${config?.customDomain ? `Custom domain: ${baseUrl}\n` : ""}` +
      `Manual check: ${identityUrl.href}\n` +
      `Last error: ${lastDetail}`,
  );
}


export function deploymentVerificationUrl(
  config: MicrofeedConfig,
): string | null {
  return config.customDomain
    ? `https://${config.customDomain}`
    : config.deploymentUrl;
}


export async function deployConfiguredProject(
  context: CommandContext,
  config: MicrofeedConfig,
  includeNewSigningSecret: boolean,
  initializeAdmin = false,
  initializeDefaultTheme = false,
): Promise<MicrofeedConfig> {
  await verifyBundledThemeReleases(repositoryRoot);
  const sourceCommitSha = await repositoryCommitSha(context.runner);
  await configureAdminAuth(context, config);
  await generateWranglerConfig(config);
  if (initializeAdmin) {
    await collectInitialAdminSetupEmail(context, config);
  }
  await context.cloudflare.applyMigrations(config);
  await prepareItemSearch(context.cloudflare, config);
  markStep(config, "migrations-applied");
  await writeConfig(config);
  if (initializeDefaultTheme) {
    const {installBundledThemesForInitialization} = await import("../theme");
    await installBundledThemesForInitialization(config, context.runner, false);
    markStep(config, "default-theme-installed");
    await writeConfig(config);
  } else {
    const {synchronizeBundledThemes} = await import("../theme");
    await synchronizeBundledThemes(config, context.runner, false);
  }
  if (initializeAdmin) {
    await prepareInitialAdminSetup(context, config);
  }
  await runChecks(context.runner, config);
  await setItemSearchReady(context.cloudflare, config, false);

  const needsAuthSecret = adminAuthMode(config) === "built-in" &&
    !config.completedSteps.includes("better-auth-secret-created");
  const needsUploadSigningSecret = includeNewSigningSecret &&
    !config.completedSteps.includes("upload-signing-secret-created") &&
    !config.completedSteps.includes("worker-deployed");
  const needsWebhookSecret = webhookProvisioned(config) &&
    !config.completedSteps.includes("webhook-secret-created");
  let deploymentUrl;
  try {
    deploymentUrl = needsAuthSecret || needsUploadSigningSecret || needsWebhookSecret
      ? await withEphemeralSecretFile(
          needsAuthSecret,
          needsUploadSigningSecret,
          needsWebhookSecret,
          (filename) => context.cloudflare.deploy(
            config,
            filename,
            sourceCommitSha,
          ),
        )
      : await context.cloudflare.deploy(config, undefined, sourceCommitSha);
  } catch (error) {
    try {
      await prepareItemSearch(context.cloudflare, config);
    } catch (recoveryError) {
      throw new Error(
        `${errorMessage(error)}\n\nThe deployment failed, and microfeed also ` +
          "could not restore search readiness after that failure. " +
          errorMessage(recoveryError),
      );
    }
    throw error;
  }
  config.deploymentUrl = deploymentUrl ?? config.deploymentUrl;
  if (needsAuthSecret) {
    markStep(config, "better-auth-secret-created");
  }
  if (needsUploadSigningSecret) {
    markStep(config, "upload-signing-secret-created");
  }
  if (needsWebhookSecret) {
    markStep(config, "webhook-secret-created");
  }
  markStep(config, "worker-deployed");
  await writeConfig(config);

  // A request handled by the previous Worker version can land after the
  // pre-deploy pass. Reconcile once the new writer is active before search is
  // considered ready.
  await prepareItemSearch(context.cloudflare, config);

  if (!config.deploymentUrl) {
    throw new Error(
      "Wrangler deployed successfully but did not report a workers.dev URL.",
    );
  }
  await verifyDeployment(config, deploymentVerificationUrl(config)!, {
    runner: context.runner,
  });
  markStep(config, "deployment-verified");
  await writeConfig(config);
  return config;
}


export async function databaseTableNames(
  cloudflare: CloudflareClient,
  config: MicrofeedConfig,
  options: {local?: boolean; persistTo?: string} = {},
): Promise<string[]> {
  const rows = await cloudflare.queryD1(
    config,
    "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    options,
  );
  return rows.flatMap(({name}) => typeof name === "string" ? [name] : []);
}


export async function databaseIndexDefinitions(
  cloudflare: CloudflareClient,
  config: MicrofeedConfig,
  tables: readonly string[] | null = null,
  options: {local?: boolean; persistTo?: string} = {},
): Promise<SnapshotIndexDefinition[]> {
  if (tables?.length === 0) return [];
  const tableFilter = tables
    ? ` AND tbl_name IN (${tables.map(sqlString).join(", ")})`
    : "";
  const rows = await cloudflare.queryD1(
    config,
    "SELECT name, sql FROM sqlite_schema WHERE type = 'index' " +
      `AND sql IS NOT NULL${tableFilter} ORDER BY name`,
    options,
  );
  return rows.map(({name, sql}) => {
    if (typeof name !== "string" || !name || typeof sql !== "string" || !sql) {
      throw new Error("D1 returned an invalid index definition.");
    }
    return {name, sql: `${sql.trim().replace(/;$/u, "")};`};
  });
}


export async function migrationLedger(
  cloudflare: CloudflareClient,
  config: MicrofeedConfig,
  options: {local?: boolean; persistTo?: string} = {},
): Promise<string[]> {
  const rows = await cloudflare.queryD1(
    config,
    "SELECT name FROM d1_migrations ORDER BY id",
    options,
  );
  return rows.map(({name}) => {
    if (typeof name !== "string" || !name) {
      throw new Error("D1 returned an invalid migration ledger.");
    }
    return name;
  });
}


export async function durableRowCounts(
  cloudflare: CloudflareClient,
  config: MicrofeedConfig,
  tables: readonly string[],
  options: {local?: boolean; persistTo?: string} = {},
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of tables) {
    const [row] = await cloudflare.queryD1(
      config,
      `SELECT COUNT(*) AS count FROM ${sqlIdentifier(table)}`,
      options,
    );
    if (!row || !Number.isSafeInteger(row.count) || Number(row.count) < 0) {
      throw new Error(`D1 returned an invalid row count for ${table}.`);
    }
    result[table] = Number(row.count);
  }
  return result;
}


export async function remoteRestoreFingerprint(
  cloudflare: CloudflareClient,
  config: MicrofeedConfig,
): Promise<string> {
  const tableNames = await databaseTableNames(cloudflare, config);
  const applicationTables = applicationTablesFromSqlite(tableNames);
  assertClassifiedTables(applicationTables);
  const rows: Record<string, Array<Record<string, unknown>>> = {};
  for (const table of [
    ...SNAPSHOT_TABLES.durable,
    ...SNAPSHOT_TABLES.targetSpecific,
  ].filter((table) => applicationTables.includes(table))) {
    rows[table] = await cloudflare.queryD1(
      config,
      `SELECT * FROM ${sqlIdentifier(table)} ORDER BY rowid`,
    );
  }
  const [migrations, objects] = await Promise.all([
    migrationLedger(cloudflare, config),
    cloudflare.listR2Objects(cloudflareAccountId(config), config.r2.name),
  ]);
  return createHash("sha256").update(JSON.stringify({
    applicationTables,
    migrations,
    objects,
    rows,
  })).digest("hex");
}


export function snapshotOutputPath(flags: Flags, instanceName: string): string {
  const requested = flagString(flags, "output");
  if (requested) {
    return path.resolve(requested);
  }
  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  return path.resolve(`microfeed-${instanceName}-${timestamp}.tar.gz`);
}

export const COMPLETED_CLOUDFLARE_INIT_STEPS = [
  "d1-ready",
  "worker-deployed",
  "deployment-verified",
] as const;


export interface CommandContext {
  cloudflare: CloudflareClient;
  cloudflareLoginEmail?: string;
  flags: Flags;
  instanceName?: string;
  pendingAdminEmail?: string;
  runner: CommandRunner;
}


export const DEPLOYMENT_VERIFICATION_RETRY_DELAYS_MS = [
  5_000,
  10_000,
  20_000,
  40_000,
  80_000,
  160_000,
] as const;


export interface DeploymentVerificationOptions {
  adminPath?: string;
  expectedAdminStatus?: number;
  runner?: CommandRunner;
  verifyAdminLogin?: boolean;
}


export type Flags = Record<string, FlagValue>;


export async function collectInitialAdminSetupEmail(
  context: CommandContext,
  config: MicrofeedConfig,
): Promise<void> {
  if (adminAuthMode(config) !== "built-in") {
    return;
  }
  const owner = await context.cloudflare.authOwner(config);
  if (!owner) {
    context.pendingAdminEmail ??= await adminEmailInput(
      context,
      context.cloudflareLoginEmail,
    );
  }
}


export async function configureAdminAuth(
  context: CommandContext,
  config: MicrofeedConfig,
): Promise<void> {
  if (config.adminAuthMode) {
    return;
  }
  const requestedMode = flagString(context.flags, "admin-auth");
  if (
    requestedMode !== undefined &&
    requestedMode !== "built-in" &&
    requestedMode !== "none"
  ) {
    throw new Error(
      "`--admin-auth` must be either `built-in` or `none`.",
    );
  }
  const selectedMode = requestedMode ??
    (flagBoolean(context.flags, "yes")
      ? "built-in"
      : await chooseAdminAuthSetup());
  if (selectedMode === "none") {
    prompts.note(
      "Anyone on the internet will be able to open the admin dashboard and " +
        "create, edit, or delete content. Only continue if you understand " +
        "the risk and plan to protect the dashboard path with Cloudflare Zero " +
        "Trust Access.",
      "Danger: admin dashboard will be public",
    );
    if (
      !flagBoolean(context.flags, "yes") &&
      !await askConfirm(
        "Deploy without built-in admin authentication?",
        false,
      )
    ) {
      throw new Error(
        "Deployment cancelled. No authentication setting was changed.",
      );
    }
  }
  config.adminAuthMode = selectedMode;
  await writeConfig(config);
}


export async function prepareInitialAdminSetup(
  context: CommandContext,
  config: MicrofeedConfig,
): Promise<void> {
  if (adminAuthMode(config) !== "built-in") {
    return;
  }
  const owner = await context.cloudflare.authOwner(config);
  if (owner) {
    context.pendingAdminEmail = undefined;
    markStep(config, "auth-owner-created");
    await writeConfig(config);
    return;
  }

  const email = context.pendingAdminEmail ?? await adminEmailInput(context);
  const password = unsafeAdminPassword(context.flags);
  if (password === undefined) {
    context.pendingAdminEmail = email;
    return;
  }

  const sql = `${await ownerInsertSql(email, password)}\n${
    clearPasswordSetupSql()
  }`;
  await withEphemeralSqlFile(
    sql,
    (filename) => context.cloudflare.executeAuthSql(config, filename),
  );
  const created = await context.cloudflare.authOwner(config);
  if (!created) {
    throw new Error("The dashboard login was not created.");
  }
  markStep(config, "auth-owner-created");
  await writeConfig(config);
}


export async function runChecks(
  runner: CommandRunner,
  config: MicrofeedConfig,
): Promise<void> {
  await withFrameworkWranglerConfig(config, async (configPath) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MICROFEED_INSTANCE: config.instanceName,
      MICROFEED_WRANGLER_CONFIG: configPath,
    };
    const execute = async (currentActivity: WaitActivity): Promise<void> => {
      currentActivity.update("Generating Worker binding types");
      await runYarnScript(runner, "types", {env});
      currentActivity.update("Checking TypeScript and Astro");
      await runYarnScript(runner, "typecheck", {env});
      currentActivity.update("Running deployment smoke tests");
      await runYarnScript(runner, "test:deploy", {env});
      currentActivity.update("Building the Worker");
      await runYarnScript(runner, "build", {env});
    };
    await withSpinner(
      {
        error: "Checks or build failed",
        start: "Preparing checks and build",
        success: "Checks and build passed",
      },
      execute,
    );
  });
}


export function sqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}


export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}


export function verificationErrorDetail(error: unknown, hostname: string): string {
  const chain = errorDetails(error);

  if (chain.some(({name}) => name === "AbortError")) {
    return `request timed out after ${
      DEPLOYMENT_VERIFICATION_TIMEOUT_MS / 1_000
    } seconds`;
  }

  const codedError = chain.find(({code}) => typeof code === "string");
  const code = typeof codedError?.code === "string"
    ? codedError.code
    : undefined;
  const errorHostname = typeof codedError?.hostname === "string"
    ? codedError.hostname
    : hostname;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `DNS lookup failed for ${errorHostname} (${code})`;
  }
  if (
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "ECONNREFUSED"
  ) {
    return `connection to ${errorHostname} failed (${code})`;
  }

  const messages = [...new Set(chain.flatMap(({message}) =>
    typeof message === "string" && message !== "fetch failed"
      ? [message]
      : []
  ))];
  if (code?.includes("CERT") || code?.startsWith("ERR_TLS_")) {
    return `TLS check failed for ${errorHostname} (${code})` +
      (messages.length > 0 ? `: ${messages.join(": ")}` : "");
  }
  if (messages.length > 0) {
    return messages.join(": ");
  }
  return error instanceof Error ? error.message : String(error);
}


export async function verifyDeploymentOnce(
  config: MicrofeedConfig | null,
  baseUrl: string,
  options: DeploymentVerificationOptions,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    DEPLOYMENT_VERIFICATION_TIMEOUT_MS,
  );
  try {
    const identity = await readMicrofeedIdentity(
      baseUrl,
      options.runner,
      controller.signal,
    );
    if (
      config !== null &&
      identity.instanceId !== config.instanceId
    ) {
      throw new Error(
        "The deployed Worker does not match this microfeed installation.",
      );
    }
    const expectedAdminStatus = options.expectedAdminStatus ??
      (options.verifyAdminLogin ? 200 : null);
    if (expectedAdminStatus !== null) {
      const loginUrl = new URL(
        adminUrl("login", options.adminPath),
        baseUrl,
      );
      const loginResponse = await verificationHttpGet(
        loginUrl,
        options.runner,
        controller.signal,
        "manual",
      );
      if (loginResponse.status !== expectedAdminStatus) {
        throw new Error(
          `The dashboard login check at ${loginUrl.href} returned ` +
            `HTTP ${loginResponse.status}; expected ` +
            `HTTP ${expectedAdminStatus}.`,
        );
      }
    }
    return identity.usedDnsOverHttps;
  } finally {
    clearTimeout(timeout);
  }
}


export async function withEphemeralSecretFile<T>(
  includeBetterAuthSecret: boolean,
  includeUploadSigningKey: boolean,
  includeWebhookSecret: boolean,
  callback: (filename: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), "microfeed-secrets-"));
  const filename = path.join(directory, "secrets.json");
  try {
    await writeFile(
      filename,
      JSON.stringify({
        ...(includeBetterAuthSecret
          ? {BETTER_AUTH_SECRET: randomBytes(32).toString("base64url")}
          : {}),
        ...(includeUploadSigningKey
          ? {UPLOAD_SIGNING_KEY: randomBytes(32).toString("base64url")}
          : {}),
        ...(includeWebhookSecret
          ? {WEBHOOK_SECRET_KEY: randomBytes(32).toString("base64url")}
          : {}),
      }),
      {encoding: "utf8", mode: 0o600},
    );
    return await callback(filename);
  } finally {
    await unlink(filename).catch(() => undefined);
    await rmdir(directory).catch(() => undefined);
  }
}

export const DEPLOYMENT_VERIFICATION_TIMEOUT_MS = 15_000;

export type FlagValue = boolean | string;

export async function adminEmailInput(
  context: CommandContext,
  defaultValue?: string,
): Promise<string> {
  prompts.note(
    "This is the email you will use to sign in to your microfeed dashboard. " +
      "It does not need to match your Cloudflare login and is not shown " +
      "publicly.",
    "Dashboard sign-in email",
  );
  const fromFlag = flagString(context.flags, "owner-email");
  const nonInteractiveDefault = flagBoolean(context.flags, "yes")
    ? defaultValue
    : undefined;
  if (
    !fromFlag &&
    !nonInteractiveDefault &&
    flagBoolean(context.flags, "yes")
  ) {
    throw new Error(
      "Pass `--owner-email <email>` when using `--yes`. This is the email " +
        "used to sign in to the microfeed dashboard. An authenticated " +
        "Cloudflare login email is used automatically when available.",
    );
  }
  const emailInput = fromFlag ?? nonInteractiveDefault ??
    await askText("Dashboard sign-in email", defaultValue);
  const emailError = validateOwnerEmail(emailInput);
  if (emailError) {
    throw new Error(emailError);
  }
  return normalizeOwnerEmail(emailInput);
}


export function errorDetails(error: unknown): ErrorDetails[] {
  const chain: ErrorDetails[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (
    current !== null &&
    typeof current === "object" &&
    !seen.has(current) &&
    chain.length < 5
  ) {
    seen.add(current);
    const details = current as ErrorDetails;
    chain.push(details);
    current = details.cause;
  }
  return chain;
}


export async function readMicrofeedIdentity(
  baseUrl: string,
  runner?: CommandRunner,
  signal?: AbortSignal,
): Promise<VerifiedMicrofeedIdentity> {
  const identityUrl = new URL("/.well-known/microfeed.json", baseUrl);
  const identityResponse = await verificationHttpGet(
    identityUrl,
    runner,
    signal,
  );
  if (
    identityResponse.status < 200 ||
    identityResponse.status >= 300
  ) {
    throw new Error(
      `microfeed identity check at ${identityUrl.href} returned ` +
        `HTTP ${identityResponse.status}.`,
    );
  }
  let data: {instanceId?: unknown; product?: unknown};
  try {
    data = JSON.parse(identityResponse.body) as typeof data;
  } catch {
    throw new Error(
      `microfeed identity check at ${identityUrl.href} returned invalid JSON.`,
    );
  }
  if (
    data.product !== "microfeed" ||
    typeof data.instanceId !== "string" ||
    data.instanceId.length === 0
  ) {
    throw new Error(
      `The endpoint at ${identityUrl.href} is not a microfeed installation.`,
    );
  }
  return {
    instanceId: data.instanceId,
    usedDnsOverHttps: identityResponse.usedDnsOverHttps,
  };
}


export function unsafeAdminPassword(flags: Flags): string | undefined {
  validateUnsafeAdminPasswordFlag(flags);
  const password = flagString(flags, "admin-password");
  if (password === undefined) {
    return undefined;
  }
  prompts.log.warn(
    "Unsafe password option in use. Command arguments can be exposed in " +
      "shell history, process listings, agent transcripts, and CI logs. " +
      "The password will not be printed or saved by microfeed.",
  );
  return password;
}


export async function verificationHttpGet(
  url: URL,
  runner?: CommandRunner,
  signal?: AbortSignal,
  redirect: RequestRedirect = "follow",
): Promise<VerificationHttpResult> {
  try {
    const response = await fetch(url, {
      redirect,
      ...(signal ? {signal} : {}),
    });
    return {
      body: await response.text(),
      location: response.headers.get("location") ?? "",
      status: response.status,
      usedDnsOverHttps: false,
    };
  } catch (error) {
    if (!runner || !isDnsLookupError(error)) {
      throw error;
    }
    prompts.log.info(
      `System DNS cannot resolve ${url.hostname}; checking immediately ` +
        "through Cloudflare DNS over HTTPS.",
    );
    const result = await curlWithCloudflareDns(runner, url);
    if (!result) {
      throw error;
    }
    return result;
  }
}


export async function withEphemeralSqlFile<T>(
  sql: string,
  callback: (filename: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), "microfeed-auth-"));
  const filename = path.join(directory, "auth.sql");
  try {
    await writeFile(filename, `${sql}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return await callback(filename);
  } finally {
    await unlink(filename).catch(() => undefined);
    await rmdir(directory).catch(() => undefined);
  }
}


export async function withFrameworkWranglerConfig<T>(
  config: MicrofeedConfig,
  callback: (configPath: string) => Promise<T>,
): Promise<T> {
  const sourcePath = wranglerConfigPath(config);
  const relativePath = relativePathFromDirectory(repositoryRoot, sourcePath);
  if (relativePath !== undefined) return await callback(relativePath);

  // Astro resolves configPath as a URL, while Cloudflare's Vite plugin resolves
  // it as a filesystem path. A repository-relative path satisfies both. When
  // Windows stores the generated config on another drive, stage a disposable
  // copy beside the repository because no relative path spans drive letters.
  const stagingRoot = path.join(
    repositoryRoot,
    ".microfeed",
    "framework-configs",
  );
  await mkdir(stagingRoot, {recursive: true});
  const stagingDirectory = await mkdtemp(path.join(stagingRoot, "wrangler-"));
  try {
    const stagedPath = path.join(stagingDirectory, "wrangler.jsonc");
    await copyFile(sourcePath, stagedPath);
    const stagedRelativePath = relativePathFromDirectory(
      repositoryRoot,
      stagedPath,
    );
    if (stagedRelativePath === undefined) {
      throw new Error("Could not prepare a repository-relative Wrangler config.");
    }
    return await callback(stagedRelativePath);
  } finally {
    await rm(stagingDirectory, {force: true, recursive: true});
  }
}

export interface ErrorDetails {
  cause?: unknown;
  code?: unknown;
  hostname?: unknown;
  message?: unknown;
  name?: unknown;
}


export interface VerifiedMicrofeedIdentity {
  instanceId: string;
  usedDnsOverHttps: boolean;
}


export function validateUnsafeAdminPasswordFlag(flags: Flags): void {
  if (flags["admin-password"] === true) {
    throw new Error("`--admin-password` requires a value.");
  }
  const password = flagString(flags, "admin-password");
  if (password === undefined) {
    return;
  }
  const error = validateOwnerPassword(password);
  if (error) {
    throw new Error(error);
  }
}


export interface VerificationHttpResult {
  body: string;
  location: string;
  status: number;
  usedDnsOverHttps: boolean;
}


export function isDnsLookupError(error: unknown): boolean {
  return errorDetails(error).some(
    ({code}) => code === "ENOTFOUND" || code === "EAI_AGAIN",
  );
}


export async function curlWithCloudflareDns(
  runner: CommandRunner,
  url: URL,
): Promise<VerificationHttpResult | null> {
  const writeOut = `${CURL_HTTP_STATUS_MARKER}%{http_code}` +
    `${CURL_REDIRECT_URL_MARKER}%{redirect_url}`;
  let result;
  try {
    result = await runner(
      "curl",
      [
        "--silent",
        "--show-error",
        "--max-time",
        String(DEPLOYMENT_VERIFICATION_TIMEOUT_MS / 1_000),
        "--doh-url",
        CLOUDFLARE_DOH_URL,
        "--write-out",
        writeOut,
        url.href,
      ],
      {allowFailure: true},
    );
  } catch {
    return null;
  }
  if (result.exitCode !== 0) {
    return null;
  }
  const statusMarkerIndex = result.stdout.lastIndexOf(
    CURL_HTTP_STATUS_MARKER,
  );
  const redirectMarkerIndex = result.stdout.lastIndexOf(
    CURL_REDIRECT_URL_MARKER,
  );
  if (
    statusMarkerIndex < 0 ||
    redirectMarkerIndex <= statusMarkerIndex
  ) {
    return null;
  }
  const status = Number(
    result.stdout.slice(
      statusMarkerIndex + CURL_HTTP_STATUS_MARKER.length,
      redirectMarkerIndex,
    ),
  );
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    return null;
  }
  return {
    body: result.stdout.slice(0, statusMarkerIndex),
    location: result.stdout.slice(
      redirectMarkerIndex + CURL_REDIRECT_URL_MARKER.length,
    ).trim(),
    status,
    usedDnsOverHttps: true,
  };
}

export const CURL_HTTP_STATUS_MARKER = "\n__MICROFEED_HTTP_STATUS__:";

export const CURL_REDIRECT_URL_MARKER = "\n__MICROFEED_REDIRECT_URL__:";


export const CLOUDFLARE_DOH_URL = "https://cloudflare-dns.com/dns-query";
