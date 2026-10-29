/**
 * Mail settings write (`POST /admin/ajax/mail-settings/save`).
 *
 * Body: `{patch: {fromAddress?, fromName?, subjectTemplate?, bodyTemplate?}}`
 * —— read-merge-write（`saveMailSettingsConfig`）：服务端补 `updatedAtMs` /
 * `updatedBy`，只动提交的键。四个字段的**空串是合法值**（= 回落出厂默认），
 * 因此「清空模板」是一条正常指令，不是缺参。
 *
 * Guarded by `system:mail-settings:manage`；非字符串 patch 值直接 400
 * （discriminated result，不抛异常）。
 *
 * 不做缓存失效：邮件设置**没有** read-through 缓存（理由见
 * `src/server/mail/mail-config.ts` 顶部注释），保存即生效。
 */
import {cache, env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import FeedDb from "@/server/feed/FeedDb";
import {
  saveMailSettingsConfig,
  type MailSettingsPatch,
} from "@/server/mail/mail-config";
import {jsonResponse, localizedError} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

export const POST: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.SYSTEM_MAIL_SETTINGS_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const userId = locals.authUser?.id;
  if (!userId) {
    return localizedError(request, "errors.account.notFound", 404);
  }
  const body = await request.json().catch(() => null) as
    | {patch?: unknown}
    | null;
  const result = await saveMailSettingsConfig(
    new FeedDb(env, request, cache),
    (body?.patch ?? {}) as MailSettingsPatch,
    userId,
  );
  if (!result.ok) {
    return localizedError(request, "errors.mailSettings.invalidConfig", 400);
  }
  return jsonResponse({ok: true});
};
