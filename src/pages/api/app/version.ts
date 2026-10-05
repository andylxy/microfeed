/**
 * `GET /api/app/version` —— App 的升级描述符（spec §6.5）。
 *
 * 刻意做成匿名：被强制升级的客户端（或从未登录的客户端）也要能拿到「必须升级」这件事
 * 本身以及新包的下载地址。因此它读取地板，但**永不**返回 426 —— 426 只出现在内容端点
 * 命名空间 `/api/AppBookRequest/*`（ADR-0005）。
 *
 * **副作用：每次调用记一条登录**（需求 3 追加，2026-10-04）。App 每次启动只检查一次
 * （工单 18），所以「一次启动 = 一次登录」，写入 `ext_app_login_log`：更新最后登录时间、
 * 登录次数 +1。放在这个端点而不是设备登记，正是为了覆盖**未登录启动**（本端点匿名，
 * 设备登记在身份验证之后）—— 否则「找出启动过的 App」永远查不到未登录的那部分。
 * 带了 Bearer 的检查会解析出用户并一并写入；解析失败只影响归属，不影响响应。
 *
 * **刻意不限流**（spec §12，票据 15 已定）。⚠️ 但该决定的前提是「只读不写」，而登录日志
 * 引入后本端点**每次请求都会写一行**（一次 upsert），前提已变：现在它是一个（很小的）
 * 写放大面。当前仍维持不限流——App 只在启动时调用一次、写入是命中 UNIQUE 索引的单条
 * upsert——但若边缘日志显示该路径被高频刷，升级优先级高于票据 15 当时的判断：应尽快
 * 加按客户端 IP 的极简 D1 计数器（形状照 `ext_auth_throttle`）。
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
import {recordLoginLog} from "@/server/app-version/login-log";
import {
  compareVersionCode,
  parseAppVersionCode,
  resolveMinVersionForRequest,
} from "@/server/app-version/resolve";
import {providedLoginCredentialBearer} from "@/server/auth/credential-login";
import {verifyLoginCredentialToken} from "@/server/auth/login-credentials";
import {deviceIdFromRequest} from "@/server/rbac/resolve";
import {jsonResponse} from "@/server/http";

export const GET: APIRoute = async ({request}) => {
  const db = env.FEED_DB;
  const deviceId = deviceIdFromRequest(request);
  const [config, resolved] = await Promise.all([
    readAppVersionConfig(db),
    resolveMinVersionForRequest(db, {deviceId}),
  ]);

  // 需求 3 追加：每个检查算一次登录。**不**阻断响应 —— 这是日志，写失败不该让客户端
  // 拿不到升级信息（拿不到就等于把它挡在门外）。没有 `X-Device-Id` 时无法归属设备，跳过。
  if (deviceId) {
    try {
      // 复用既有的 bearer 解析（`mflc_…` 前缀校验也在里面）：不在本文件重写一份。
      const token = providedLoginCredentialBearer(request);
      const verified = token
        ? await verifyLoginCredentialToken(db, token)
        : null;
      await recordLoginLog(db, verified?.userId ?? null, deviceId);
    } catch (error) {
      console.warn("app/version: 登录日志写入失败，忽略", error);
    }
  }

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
