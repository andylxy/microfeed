/**
 * Mail settings read (`GET /admin/ajax/mail-settings`).
 *
 * 返回三块，缺一不可（后台卡片靠它们画出「留空 = 用默认」的语义）：
 *   - `config`   库里已存的四项非 secret 配置（`mail_settings`）
 *   - `defaults` 出厂模板（`DEFAULT_OTP_EMAIL_TEMPLATE`），供卡片占位与预览
 *   - `delivery` 发信通道状态：API Key 是否已配、未配地址时回落哪个发信地址
 *
 * **密钥永不出服务端**：`RESEND_API_KEY` 只以布尔形态出现在 `delivery`，
 * 连末四位都不给（它不像 Cloudflare Token 那样由后台录入，改它要动 Workers
 * secret，后台无权也无必要回显）。
 *
 * Guarded by `system:mail-settings:read`；写路径在同目录 `save.ts`（`:manage`）。
 */
import {cache, env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import FeedDb from "@/server/feed/FeedDb";
import {DEFAULT_OTP_EMAIL_TEMPLATE} from "@/server/mail/email-templates";
import {readMailSettingsConfig} from "@/server/mail/mail-config";
import {jsonResponse} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

export const GET: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.SYSTEM_MAIL_SETTINGS_READ,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  // 第三个参数（公共缓存清理器）是 `source-architecture.test.ts` 的棘轮要求：
  // 只读路径也有义务显式声明「我不清理」，而不是靠「少传一个参数」隐式声明。
  const db = new FeedDb(env, request, cache);
  return jsonResponse(
    {
      config: await readMailSettingsConfig(db),
      defaults: {
        subjectTemplate: DEFAULT_OTP_EMAIL_TEMPLATE.subject,
        bodyTemplate: DEFAULT_OTP_EMAIL_TEMPLATE.bodyHtml,
      },
      delivery: {
        apiKeyConfigured: (env.RESEND_API_KEY ?? "").trim() !== "",
        fallbackFrom: (env.RESEND_FROM ?? "").trim(),
      },
    },
    {headers: {"cache-control": "private, no-store"}},
  );
};
