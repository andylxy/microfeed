/**
 * `GET /api/app/mingci-permission` —— App 启动时拉取「当前账号是否能查看名词解释」，
 * G3 单开关 → 一个布尔 `allowed`。
 *
 * 这里只做**协议翻译**：把
 * {@link resolveMingCiPermission} 给的事实映射成 HTTP 状态码。真正的凭证校验与
 * 权限解析在 `@/server/app-mingci-permission/resolve`，按 AGENTS.md「源码架构」
 * （Worker 专属代码放 `src/server/`、路由保持精简）。
 *
 * 语义要点（fail-closed，INV-1 / INV-2，逐字镜像 search-permission）：
 * - 端点挂在 legacy `/api/` 基，由 middleware 完整鉴权链看守（限流 / 封禁 /
 *   设备吊销 / `app:mobile:access`）；只有已通过 `app:mobile:access` 的登录凭证
 *   才能抵达本处理器。
 * - 角色不命中 = 200 {allowed:false}（这是**有效答案**，客户端据此不加载名词列表且不重试）。
 * - 凭证无效 / 缺失 = 401（middleware 已挡，此处保底；触发客户端失败 + 退避重试）。
 * - DB 异常 = 500，**绝不**伪装成 false（否则「服务端炸了」和「没权限」分不清，
 *   运维也无法从状态码区分）。
 *
 * 不属于 AppBookRequest 信封（`{code,data,msg}`），不进 OpenAPI 清单（AGENTS.md
 * 对 `/api/app/*` 的点名豁免同理）。运行时约定由
 * `tests/worker/app-mingci-permission.test.ts` 锁定。
 */

import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {resolveMingCiPermission} from "@/server/app-mingci-permission/resolve";
import {jsonResponse} from "@/server/http";

const NO_STORE: ResponseInit["headers"] = {"cache-control": "no-store"};

export const GET: APIRoute = async ({request}) => {
  const outcome = await resolveMingCiPermission(env.FEED_DB, request);

  switch (outcome.kind) {
    case "ok":
      return jsonResponse(
        {allowed: outcome.allowed},
        {headers: NO_STORE},
      );
    case "missing-bearer":
      return jsonResponse(
        {error: "missing bearer"},
        {status: 401, headers: NO_STORE},
      );
    case "invalid-bearer":
      return jsonResponse(
        {error: "invalid bearer"},
        {status: 401, headers: NO_STORE},
      );
    case "resolution-failed":
      return jsonResponse(
        {error: "permission resolution failed"},
        {status: 500, headers: NO_STORE},
      );
  }
};
