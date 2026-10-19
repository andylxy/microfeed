import type {AdminAuthMode} from "@/shared/AdminAuth";

export interface Account {
  id: string;
  name: string;
}

export type InstanceHosting = "cloudflare" | "local";
export type R2SetupMode = "automatic" | "disabled";
export type WebhookInfrastructureState =
  | "unprovisioned"
  | "enabled"
  | "disabled";
export type WebhookInfrastructureTransition = "enabling" | "disabling";

export interface MicrofeedConfig {
  accountId: string | null;
  adminAuthMode?: AdminAuthMode;
  adminPath: string;
  completedSteps: string[];
  customDomain: string | null;
  deploymentEnvironment?: "preview" | "production";
  d1: {
    id: string;
    name: string;
    reuse: boolean;
  };
  deploymentUrl: string | null;
  hosting: InstanceHosting;
  instanceId: string;
  instanceName: string;
  pagesProjectName?: string;
  projectName: string;
  r2: {
    name: string;
    reuse: boolean;
    setupMode: R2SetupMode;
  };
  restoreBaseline?: {
    createdAt: string;
    fingerprint: string;
  };
  webhooks?: {
    queueId?: string;
    queueName: string;
    state: WebhookInfrastructureState;
    transition?: WebhookInfrastructureTransition;
  };
  workerName?: string;
}

export interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface RunOptions {
  allowFailure?: boolean;
  cwd?: string;
  env?: Partial<NodeJS.ProcessEnv>;
  input?: string;
  interactive?: boolean;
  /**
   * Long-lived children (the Astro dev server) stream their output live and
   * must never see their stdin reach EOF: Vite's dev server terminates when
   * its stdin ends, and every layer between the terminal and the child
   * (`yarn run`, wrapped launchers, redirected output) can close stdin early.
   * The child therefore gets a stdin pipe that stays open for its whole
   * lifetime instead of an inherited handle that may already be dead.
   */
  longRunning?: boolean;
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<CommandResult>;
