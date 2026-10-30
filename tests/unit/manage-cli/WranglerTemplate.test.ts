import {readFile} from "node:fs/promises";

import {describe, expect, it} from "vitest";

import {
  adminAuthMode,
  requiredSecrets,
  webhookQueueName,
  workersCacheEnabled,
  workersDevEnabled,
} from "../../../manage-cli/lib/config";
import type {MicrofeedConfig} from "../../../manage-cli/types";

/** 模板是 `.jsonc`：占位符替换后仍有整行 `//` 注释，需先剥掉再交给 `JSON.parse`。 */
function stripLineComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*\/\//u.test(line))
    .join("\n");
}

/**
 * 把 `wrangler.template.jsonc` 渲染成可解析的对象，占位符取本文件用到的固定替身。
 * 只替换与断言相关的占位符；其余字符串占位符原样保留，断言里按原样比对。
 */
async function renderTemplate(requiredSecretsJson: string): Promise<Record<string, unknown>> {
  const template = await readFile(
    new URL("../../../wrangler.template.jsonc", import.meta.url),
    "utf8",
  );
  return JSON.parse(stripLineComments(
    template
      .replace("__WORKERS_DEV__", "true")
      .replace("__WORKERS_CACHE_ENABLED__", "true")
      .replace("__REQUIRED_SECRETS__", requiredSecretsJson)
      .replace("__R2_BINDING__", '"r2_buckets": [],')
      .replace("__WEBHOOK_BINDINGS__", "")
      .replace("__R2_SETUP_MODE__", "automatic")
      .replace("__ROUTES__", "[]"),
  )) as Record<string, unknown>;
}

describe("Wrangler configuration template", () => {
  const config: MicrofeedConfig = {
    accountId: "account-id",
    adminPath: "admin",
    completedSteps: [],
    customDomain: null,
    d1: {id: "d1-id", name: "feed-db", reuse: false},
    deploymentUrl: "https://feed.example.workers.dev",
    hosting: "cloudflare",
    instanceId: "instance-id",
    instanceName: "feed",
    projectName: "feed",
    r2: {name: "feed-media", reuse: false, setupMode: "automatic"},
  };

  it("disables persisted Workers Logs by default", async () => {
    const config = await renderTemplate(
      '["UPLOAD_SIGNING_KEY","BETTER_AUTH_SECRET"]',
    ) as {
      cache?: {enabled?: boolean};
      observability?: {enabled?: boolean};
      version_metadata?: {binding?: string};
      vars?: Record<string, string>;
    };

    expect(config.cache?.enabled).toBe(true);
    expect(config.observability?.enabled).toBe(false);
    expect(config.version_metadata?.binding).toBe("CF_VERSION_METADATA");
    expect(config.vars?.MICROFEED_CLOUDFLARE_ACCOUNT_ID).toBe(
      "__CLOUDFLARE_ACCOUNT_ID__",
    );
    expect(config.vars?.MICROFEED_INSTANCE_NAME).toBe("__INSTANCE_NAME__");
    expect(config.vars?.MICROFEED_R2_BUCKET_NAME).toBe(
      "__R2_BUCKET_NAME__",
    );
    expect(config.vars?.MICROFEED_R2_SETUP_MODE).toBe("automatic");
    expect(config.vars?.MICROFEED_WORKER_NAME).toBe("__WORKER_NAME__");
  });

  it("renders the QQ secrets into the per-instance config (生产 env 才不会缺键)", async () => {
    // 这条用例守的是只在线上暴露的缺口：部署用的是本模板渲染出的配置，
    // 若 QQ 键既不在 vars、也不在 secrets.required，生产 `env.QQ_APP_ID` 恒
    // undefined，第三方登录一路 fail-closed 报「QQ 校验失败」——而本地 dev
    // 读的是项目根 wrangler.jsonc，本地怎么测都发现不了。
    const parsed = await renderTemplate(
      JSON.stringify(requiredSecrets(config)),
    ) as {
      secrets?: {required?: string[]};
      vars?: Record<string, string>;
    };

    expect(parsed.secrets?.required).toContain("QQ_APP_ID");
    expect(parsed.secrets?.required).toContain("QQ_APP_SECRET");
    // 旁路开关绝不进生产配置。
    expect(parsed.secrets?.required).not.toContain("QQ_OAUTH_DEV_MOCK");
    expect(parsed.vars?.QQ_OAUTH_DEV_MOCK).toBeUndefined();
  });

  it("enables workers.dev until a custom domain is configured", () => {
    expect(workersDevEnabled(config)).toBe(true);
    expect(workersDevEnabled({
      ...config,
      customDomain: "feed.example.com",
    })).toBe(false);
  });

  it("enables Workers Caching only for Cloudflare production", () => {
    expect(workersCacheEnabled(config)).toBe(true);
    expect(workersCacheEnabled({
      ...config,
      deploymentEnvironment: "preview",
    })).toBe(false);
    expect(workersCacheEnabled({
      ...config,
      accountId: null,
      hosting: "local",
    })).toBe(false);
  });

  it("defaults to built-in auth and requires its signing secret", () => {
    expect(adminAuthMode(config)).toBe("built-in");
    // QQ 两键必须在列：部署用的是本函数渲染出的 per-instance `wrangler.jsonc`，
    // 模板 `vars` 里没有 QQ 键，不登记则生产 `env.QQ_APP_ID` 恒 undefined，
    // 第三方登录会一路 fail-closed 报「QQ 校验失败」。
    expect(requiredSecrets(config)).toEqual([
      "UPLOAD_SIGNING_KEY",
      "BETTER_AUTH_SECRET",
      "RESEND_API_KEY",
      "QQ_APP_ID",
      "QQ_APP_SECRET",
    ]);
    // 模拟旁路开关刻意不登记：生产不声明即 undefined，线上开不出旁路。
    expect(requiredSecrets(config)).not.toContain("QQ_OAUTH_DEV_MOCK");
  });

  it("does not require an auth secret when built-in auth is skipped", () => {
    const publicAdminConfig = {
      ...config,
      adminAuthMode: "none" as const,
    };

    expect(adminAuthMode(publicAdminConfig)).toBe("none");
    expect(requiredSecrets(publicAdminConfig)).toEqual([
      "UPLOAD_SIGNING_KEY",
      "RESEND_API_KEY",
      "QQ_APP_ID",
      "QQ_APP_SECRET",
    ]);
  });

  it("requires the webhook encryption secret only after explicit opt-in", () => {
    expect(requiredSecrets(config)).not.toContain("WEBHOOK_SECRET_KEY");
    expect(requiredSecrets({
      ...config,
      webhooks: {queueName: "feed-webhooks", state: "enabled"},
    })).toContain("WEBHOOK_SECRET_KEY");
    expect(requiredSecrets({
      ...config,
      webhooks: {queueName: "feed-webhooks", state: "disabled"},
    })).toContain("WEBHOOK_SECRET_KEY");
  });

  it("derives collision-resistant environment-specific Queue names", () => {
    expect(webhookQueueName("microfeed-personal")).toBe(
      "microfeed-personal-webhooks",
    );
    const first = webhookQueueName("a".repeat(63));
    const second = webhookQueueName(`${"a".repeat(62)}b`);
    expect(first).toHaveLength(63);
    expect(second).toHaveLength(63);
    expect(first).not.toBe(second);
    expect(first).toMatch(/-[a-f0-9]{10}-webhooks$/u);
  });
});
