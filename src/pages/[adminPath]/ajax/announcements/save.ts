/**
 * 公告管理看板写入端点（`POST /admin/ajax/announcements/save`）。
 *
 * Body（三选一，互斥）：
 * - `{create: {...}}`  新建
 * - `{update: {id, ...}}`  编辑（`version` 按内容改动自增，见 store）
 * - `{setStatus: {id, status}}`  删除(4) / 过期(3) / 恢复发布(2)
 *
 * Guarded by `system:announcement:manage` —— 与读取端点的 `:read` 分开，
 * 这样「能看」与「能改」可以独立授予（角色编辑器里是两个叶子）。
 *
 * 校验失败一律 400 且**不**写入：半条公告比没有公告更糟（客户端会弹空框）。
 * `setStatus` 走软删（4），不 DROP，保留审计。
 */
import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {
  createAnnouncement,
  isSettableStatus,
  setStatus,
  updateAnnouncement,
  validateAnnouncementDraft,
} from "@/server/app-announcement/store";
import {jsonResponse, localizedError} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import type {AnnouncementDraft} from "@/shared/AppAnnouncement";
import {PERMISSION_CODES} from "@/shared/Constants";

interface SaveBody {
  create?: AnnouncementDraft;
  update?: AnnouncementDraft & {id?: number};
  setStatus?: {id?: number; status?: number};
}

export const POST: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.SYSTEM_ANNOUNCEMENT_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;

  const body = await request.json().catch(() => null) as SaveBody | null;
  if (!body) {
    return localizedError(request, "errors.announcements.invalidPayload", 400);
  }

  if (body.create !== undefined) {
    const result = validateAnnouncementDraft(body.create);
    if (!result.ok) {
      return localizedError(
        request,
        `errors.announcements.${result.reason}`,
        400,
      );
    }
    const created = await createAnnouncement(env.FEED_DB, body.create);
    return jsonResponse({ok: true, row: created});
  }

  if (body.update !== undefined) {
    const {id, ...draft} = body.update;
    if (typeof id !== "number") {
      return localizedError(request, "errors.announcements.invalidPayload", 400);
    }
    // 整存语义：表单提交的是完整字段集，所以按「完整草稿」校验，
    // 空标题这类问题在这里就被拦住，而不是写进去一条空标题。
    const result = validateAnnouncementDraft({
      ...draft,
      title: draft.title ?? "",
    });
    if (!result.ok) {
      return localizedError(
        request,
        `errors.announcements.${result.reason}`,
        400,
      );
    }
    const updated = await updateAnnouncement(env.FEED_DB, id, draft);
    if (!updated) {
      return localizedError(request, "errors.announcements.notFound", 404);
    }
    return jsonResponse({ok: true, row: updated});
  }

  if (body.setStatus !== undefined) {
    const {id, status} = body.setStatus;
    // `isSettableStatus` 是**真守卫**（收窄到 AnnouncementStatus），不是断言：
    // 越界状态在这里被拒，而不是靠 `as` 无声吞掉。
    if (typeof id !== "number" || !isSettableStatus(status)) {
      return localizedError(request, "errors.announcements.invalidPayload", 400);
    }
    const updated = await setStatus(env.FEED_DB, id, status);
    if (!updated) {
      return localizedError(request, "errors.announcements.notFound", 404);
    }
    return jsonResponse({ok: true, row: updated});
  }

  return localizedError(request, "errors.announcements.invalidPayload", 400);
};
