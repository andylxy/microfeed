/**
 * 邮件设置的 IO 层（邮箱 + 验证码注册 §3.8）。
 *
 * 单行 JSON 存 `settings` 表（category=`mail_settings`），驱动验证码邮件的
 * 发信地址、发信名称、主题模板与正文模板。形状参考 `src/server/app/login/config.ts`
 * （同一套 settings 通道：getSettingsCategory / setSettingsCategory）。
 *
 * ## 为什么不做 read-through 缓存
 *
 * 登录方式配置走 `caches.default` 是因为它在**每个登录请求**上被读；邮件设置只在
 * 「发一封验证码邮件」时读一次，而发码本身已被图形验证码 + 60s 重发 + 当日上限
 * 限流，QPS 极低。加缓存需要往 `AppCacheBucket` 这个**封闭联合类型**里新增成员
 * （类型、`APP_CACHE_BUCKETS`、`TTL_TIER_OF`、默认值四处联动），为一条低频读路径
 * 扩大缓存分类面不划算——这里直接 D1 点查，保存即生效，也省掉「改了配置不生效」
 * 这类排障成本。
 *
 * ## 密钥不在这一类目里
 *
 * Resend API Key 走 Workers secret（`env.RESEND_API_KEY`），永不进 DB、永不进
 * 后台 UI。本模块只存非 secret 项。
 */

import {SETTINGS_CATEGORIES} from "@/shared/Constants";
import {
  DEFAULT_MAIL_SETTINGS,
  type MailSettingsConfig,
  type MailSettingsPatch,
} from "@/shared/MailSettings";
import type FeedDb from "@/server/feed/FeedDb";

export type {
  MailSettingsConfig,
  MailSettingsPatch,
} from "@/shared/MailSettings";
export {DEFAULT_MAIL_SETTINGS} from "@/shared/MailSettings";

export type MailSettingsWriteResult =
  | {ok: true}
  | {ok: false; reason: "invalidConfig"};

const PATCH_KEYS = [
  "fromAddress",
  "fromName",
  "subjectTemplate",
  "bodyTemplate",
] as const;

function strField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string") return "";
  return value.trim();
}

/** 归一：非字符串 / 坏类型归空串；幂等。 */
export function parseMailSettingsConfig(raw: unknown): MailSettingsConfig {
  const source = (raw !== null && typeof raw === "object"
    ? raw
    : {}) as Record<string, unknown>;
  const config: MailSettingsConfig = {
    fromAddress: strField(source, "fromAddress"),
    fromName: strField(source, "fromName"),
    subjectTemplate: strField(source, "subjectTemplate"),
    bodyTemplate: strField(source, "bodyTemplate"),
    updatedAtMs: DEFAULT_MAIL_SETTINGS.updatedAtMs,
    updatedBy: DEFAULT_MAIL_SETTINGS.updatedBy,
  };
  if (typeof source.updatedAtMs === "number" && Number.isFinite(source.updatedAtMs)) {
    config.updatedAtMs = source.updatedAtMs;
  }
  if (typeof source.updatedBy === "string" && source.updatedBy) {
    config.updatedBy = source.updatedBy;
  }
  return config;
}

/** D1 直读：主键点查 1 行。 */
export async function readMailSettingsConfig(
  db: FeedDb,
): Promise<MailSettingsConfig> {
  const raw = await db.getSettingsCategory<unknown>(
    SETTINGS_CATEGORIES.MAIL_SETTINGS,
  );
  return parseMailSettingsConfig(raw);
}

/**
 * read-merge-write 保存：patch 只接受显式字符串（其他类型 = 调用方契约错误，
 * 整次拒绝、不动库）；`updatedAtMs` / `updatedBy` 服务端置值。
 */
export async function saveMailSettingsConfig(
  db: FeedDb,
  patch: MailSettingsPatch,
  updatedBy: string,
): Promise<MailSettingsWriteResult> {
  for (const key of PATCH_KEYS) {
    if (patch[key] !== undefined && typeof patch[key] !== "string") {
      return {ok: false, reason: "invalidConfig"};
    }
  }
  const current = await readMailSettingsConfig(db);
  const next: MailSettingsConfig = {...current};
  for (const key of PATCH_KEYS) {
    if (typeof patch[key] === "string") {
      next[key] = (patch[key] as string).trim();
    }
  }
  next.updatedAtMs = Date.now();
  next.updatedBy = updatedBy;
  await db.setSettingsCategory(
    SETTINGS_CATEGORIES.MAIL_SETTINGS,
    JSON.stringify(next),
  );
  return {ok: true};
}

/**
 * 解析实际发信地址：后台配置优先，未配置回落 `env.RESEND_FROM`。
 * 带显示名时拼成 `Name <addr>`（RFC 5322 显示名形态，Resend 接受）。
 */
export function resolveFromAddress(
  config: MailSettingsConfig,
  fallback: string | undefined,
): string {
  const address = config.fromAddress || (fallback ?? "");
  if (!address) return "";
  if (!config.fromName) return address;
  return `${config.fromName} <${address}>`;
}
