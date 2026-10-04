/**
 * `GET /api/app/version` —— App 的升级描述符（spec §6.5）。
 *
 * 刻意做成匿名：被强制升级的客户端（或从未登录的客户端）也要能拿到「必须升级」这件事
 * 本身以及新包的下载地址。因此它读取地板，但**永不**返回 426 —— 426 只出现在内容端点
 * 命名空间 `/api/AppBookRequest/*`（ADR-0005）。
 *
 * **刻意不限流**（spec §12，票据 15 已定）：本处理器只读一行配置加一张小表、不写库、
 * 不需要鉴权，为每次请求加一次 D1 计数的代价比它要防的流量更高。滥用防护交给
 * Cloudflare 边缘（速率限制 / WAF）。若边缘日志显示该路径被高频刷，再加一个按客户端 IP
 * 的极简 D1 计数器（形状照 `ext_auth_throttle`）。
 *
 * 不属于 legacy `AppBookRequest` 信封（`{code,data,msg}`），也不注册进 OpenAPI 契约：
 * 它是 App 内部通道，不是公开 feed API —— 与 AGENTS.md「API 契约与文档」对
 * `/api/AppBookRequest/*` 的点名豁免同理，因该路径不在那个前缀下而在此显式点名。
 * 其运行时契约由 `tests/worker/app-version-routes.test.ts` 与
 * `tests/unit/app-version.test.ts` 锁定。它也被排除在中间件的规范化之外，
 * 以便 `/api/app/version` 这个精确 URL 被直接服务。
 */

import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {readAppVersionConfig} from "@/server/app-version/config";
import {
  compareVersionCode,
  parseAppVersionCode,
  resolveMinVersionForRequest,
} from "@/server/app-version/resolve";
import {deviceIdFromRequest} from "@/server/rbac/resolve";
import {jsonResponse} from "@/server/http";

export const GET: APIRoute = async ({request}) => {
  const db = env.FEED_DB;
  const [config, resolved] = await Promise.all([
    readAppVersionConfig(db),
    resolveMinVersionForRequest(db, {deviceId: deviceIdFromRequest(request)}),
  ]);
  // `force` 回答的是「**这个调用方**是否必须升级」，而不是「有没有地板」。
  // 只有**已配置地板**（minVersionCode > 0）且调用方低于它（或压根没上报版本）才是硬阻；
  // 地板为 0 表示「不强制升级」（migrations/0080），此时一律软提示 —— 与内容门
  // `requireAppVersion` 的「地板 <= 0 关门」保持同一语义（票据 20）。
  // 有新版本但没抬地板属软提示，由「latestVersionCode > 本机」承担（ADR-0009）。
  // App 端直接采信该值，不得自行用 `minVersionCode` 重算（ADR-0008 §5）。
  const headerCode = parseAppVersionCode(request.headers.get("app-version"));
  const force =
    resolved.minVersionCode > 0 &&
    (headerCode === null ||
      compareVersionCode(headerCode, resolved.minVersionCode) < 0);
  return jsonResponse(
    {
      downloadUrl: config.downloadUrl,
      force,
      latestVersionCode: config.latestVersionCode,
      latestVersionName: config.latestVersionName,
      md5: config.md5,
      minVersionCode: resolved.minVersionCode,
      updateLog: config.updateLog,
    },
    {headers: {"cache-control": "no-store"}},
  );
};

export const HEAD = GET;
