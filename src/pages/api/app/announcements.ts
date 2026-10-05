/**
 * `GET /api/app/announcements` —— App 的运营/系统消息（公告），DESIGN §5.3。
 *
 * 刻意做成匿名，与 `/api/app/version` 同理：公告是「后端单方面下发」的内容，
 * 客户端还没登录（甚至正因被挡在门外）也必须能读到停服通知。
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

import {listActiveAnnouncements} from "@/server/app-announcement/store";
import {ANNOUNCEMENT_FETCH_LIMIT} from "@/shared/AppAnnouncement";
import {jsonResponse} from "@/server/http";

// 单次最多下发多少条：取共享常量（防超大 payload，DESIGN §6.4），客户端另有 K=3 的展示上限。
const ANNOUNCEMENT_LIMIT = ANNOUNCEMENT_FETCH_LIMIT;

export const GET: APIRoute = async () => {
  const db = env.FEED_DB;
  try {
    const announcements = await listActiveAnnouncements(
      db,
      Date.now(),
      ANNOUNCEMENT_LIMIT,
    );
    return jsonResponse(
      {announcements},
      {headers: {"cache-control": "no-store"}},
    );
  } catch (error) {
    // 刻意不吞成空列表：客户端对两者都是静默，但运维需要能从状态码看出
    // 「服务端炸了」而不是「今天没公告」。日志保留堆栈便于定位。
    console.error("app/announcements: 读取生效公告失败", error);
    return jsonResponse(
      {error: "failed to read announcements"},
      {status: 500, headers: {"cache-control": "no-store"}},
    );
  }
};

export const HEAD = GET;
