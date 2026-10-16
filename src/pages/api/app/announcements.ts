/**
 * `GET /api/app/announcements` —— App 的运营/系统消息（公告），DESIGN §5.3。
 *
 * **2026-10-16 起要求登录凭证**（权限码 `app:announcement:read`）。此前刻意匿名，
 * 理由是「客户端还没登录也必须能读到停服通知」；该理由已作废 —— 全新安装的 App 会带
 * `SecurityConfig.getApiKey()` 的内置凭证（实测就是 logcat 里那个 `mflc_…`，
 * `mUserInfoToken` 为空时由 `loginBearer` 回落），不存在「没有凭证的客户端」。
 * 鉴权形态照 `search-permission` / `mingci-permission`。
 *
 * **不记登录日志**（DESIGN D4）：登录日志的写入点是 `/api/app/version`，
 * App 一次启动只拉一次公告，若这里也记，「一次启动」会被计成两次登录，
 * 登录次数与「启动了几次」脱钩。拉公告与登录日志刻意解耦。
 *
 * **静默是硬要求**（INV-1）：网络错误 / 解析失败一律由客户端只打 log、不弹窗。
 * 所以本端点不必为客户端区分错误类型——统一失败即可；但服务端仍返回 500
 * 而不是伪装成空列表，否则「服务端坏了」和「今天没公告」就再也分不开了。
 *
 * 不属于 legacy `AppBookRequest` 信封（`{code,data,msg}`），也不注册进 OpenAPI
 * 契约：与 `/api/app/version` 同为 App 内部通道（AGENTS.md「API 契约与文档」
 * 对 `/api/AppBookRequest/*` 的点名豁免同理）。
 * 运行时契约由 `tests/worker/app-announcement-endpoint.test.ts` 锁定。
 */

import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {resolveAnnouncementPermission} from "@/server/app/permission/announcement";
import {listActiveAnnouncements} from "@/server/app/announcement/store";
import {ANNOUNCEMENT_FETCH_LIMIT} from "@/shared/AppAnnouncement";
import {jsonResponse} from "@/server/http";

// 单次最多下发多少条：取共享常量（防超大 payload，DESIGN §6.4），客户端另有 K=3 的展示上限。
const ANNOUNCEMENT_LIMIT = ANNOUNCEMENT_FETCH_LIMIT;

const NO_STORE: ResponseInit["headers"] = {"cache-control": "no-store"};

export const GET: APIRoute = async ({request}) => {
  const db = env.FEED_DB;

  // 鉴权前置。错误措辞与 search-permission / mingci-permission **逐字一致**（空格版，
  // 不是 `{error: outcome.kind}` 那种连字符形态 —— 评审第 12 轮指出两者曾不一致）。
  const outcome = await resolveAnnouncementPermission(db, request);
  if (outcome.kind === "missing-bearer") {
    return jsonResponse({error: "missing bearer"}, {status: 401, headers: NO_STORE});
  }
  if (outcome.kind === "invalid-bearer") {
    return jsonResponse({error: "invalid bearer"}, {status: 401, headers: NO_STORE});
  }
  if (outcome.kind === "resolution-failed") {
    return jsonResponse(
      {error: "permission resolution failed"},
      {status: 500, headers: NO_STORE},
    );
  }
  if (!outcome.allowed) {
    return jsonResponse({error: "forbidden"}, {status: 403, headers: NO_STORE});
  }

  try {
    const announcements = await listActiveAnnouncements(
      db,
      Date.now(),
      ANNOUNCEMENT_LIMIT,
    );
    return jsonResponse({announcements}, {headers: NO_STORE});
  } catch (error) {
    // 刻意不吞成空列表：客户端对两者都是静默，但运维需要能从状态码看出
    // 「服务端炸了」而不是「今天没公告」。日志保留堆栈便于定位。
    console.error("app/announcements: 读取生效公告失败", error);
    return jsonResponse(
      {error: "failed to read announcements"},
      {status: 500, headers: NO_STORE},
    );
  }
};

export const HEAD = GET;
