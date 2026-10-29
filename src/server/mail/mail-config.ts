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

/**
 * 清洗发信人名称里会破坏 `Name <addr>` 拼接的字符。
 *
 * `resolveFromAddress` 用纯字符串拼 `Name <addr>`，所以名称一旦含 `<`、`>` 或
 * `"`，就会拼出 `中医百科 <x@y.com> <no-reply@a.com>` 这种非法形态，Resend 回
 * 422、且从后台界面完全看不出原因。清洗放在**写入点**而非拼接点：值只脏一次，
 * 读、渲染、发信三处都不必各自防；转义放在拼接点则同一个值被读两次就转两次。
 *
 * 只删这三个字符，不删空格——名称里的空格是合法的（`Zhang San`），Resend 接受。
 */
function sanitizeFromName(raw: string): string {
  return raw.replace(/[<>"]/gu, "").trim();
}

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
    // 读路径也清洗：DB 里可能已有保存函数上线前写入的脏值（迁移 / 手工 SQL），
    // 清洗是幂等的，脏值在读出来时就已被修正。
    fromName: sanitizeFromName(strField(source, "fromName")),
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
      // `fromName` 单独清洗：它会被拼进 `Name <addr>`，含尖括号/引号会产出
      // Resend 拒收的非法形态（详见 sanitizeFromName）。其余三项是地址与模板，
      // 原样保留——模板里的 HTML 尖括号必须留着。
      next[key] =
        key === "fromName"
          ? sanitizeFromName(patch[key] as string)
          : (patch[key] as string).trim();
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
 *
 * `fromName` 已经在保存时清洗过（见 {@link sanitizeFromName}），这里仍再洗一次：
 * 走 API 直接写库的路径（迁移 / 手工 SQL）绕不过保存函数，拼接点是最后一道。
 */
export function resolveFromAddress(
  config: MailSettingsConfig,
  fallback: string | undefined,
): string {
  const address = config.fromAddress || (fallback ?? "");
  if (!address) return "";
  const name = sanitizeFromName(config.fromName ?? "");
  if (!name) return address;
  return `${name} <${address}>`;
}
