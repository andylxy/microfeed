/**
 * 公告管理看板读取端点（`/admin/ajax/announcements/`）。
 *
 * 两个动作：
 * - `GET ?tab=all|draft|published|expired|deleted` — 该标签下的公告行；
 * - `GET ?id=<n>` — 单条公告（编辑表单回填用；不带 `tab` 时按 id 解析）。
 *
 * ⚠️ 「已过期」不是单一status：它是 `status=3`（手动过期）**或**
 * `status=2 且 valid_to < now`（时间窗口已过但状态仍是已发布）。后者若漏掉，
 * 运营会看到一条「已发布」却永远不下发的公告，且找不到原因——这正是
 * 公开生效查询与管理列表必须分成两套判定的原因（DESIGN §5.4）。
 *
 * 未知标签直接 400，**不**静默回落成 `all`：回落会让运维以为看到的是全量。
 *
 * Guarded by `system:announcement:read` — 与菜单行绑定的同一个码。
 */
import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {
  ANNOUNCEMENT_MAX_ROWS,
  getAnnouncement,
  isAnnouncementTab,
  listAdminAnnouncements,
} from "@/server/app-announcement/store";
import {jsonResponse} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

export const GET: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.SYSTEM_ANNOUNCEMENT_READ,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;

  const params = new URL(request.url).searchParams;

  // 单条读取（编辑表单回填）。带 id 时优先于 tab —— 否则「编辑草稿」这种
  // 场景下 id 与 tab 同时出现会被忽略，表单回填到错误的一条。
  const idParam = params.get("id");
  if (idParam !== null) {
    const id = Number(idParam);
    if (!Number.isInteger(id) || id <= 0) {
      return jsonResponse(
        {error: `invalid id: ${idParam}`},
        {status: 400, headers: {"cache-control": "private, no-store"}},
      );
    }
    const row = await getAnnouncement(env.FEED_DB, id);
    if (!row) {
      return jsonResponse(
        {error: "not found"},
        {status: 404, headers: {"cache-control": "private, no-store"}},
      );
    }
    return jsonResponse({row}, {headers: {"cache-control": "private, no-store"}});
  }

  const requested = params.get("tab") ?? "";
  if (requested !== "" && !isAnnouncementTab(requested)) {
    return jsonResponse(
      {error: `unknown tab: ${requested}`},
      {status: 400, headers: {"cache-control": "private, no-store"}},
    );
  }
  const tab = isAnnouncementTab(requested) ? requested : "all";

  const limit = Math.min(
    Math.max(Number(params.get("limit")) || ANNOUNCEMENT_MAX_ROWS, 1),
    ANNOUNCEMENT_MAX_ROWS,
  );
  const rows = await listAdminAnnouncements(env.FEED_DB, tab);
  const capped = rows.slice(0, limit);

  return jsonResponse(
    {tab, rows: capped, truncated: rows.length > capped.length},
    {headers: {"cache-control": "private, no-store"}},
  );
};
