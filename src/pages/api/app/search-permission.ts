/**
 * `GET /api/app/search-permission` —— App 启动时拉取「当前账号是否有搜索权限」，
 * DESIGN §5.2。
 *
 * 这里只做**协议翻译**：把
 * {@link resolveSearchPermission} 给的事实映射成 HTTP 状态码。真正的凭证校验与
 * 权限解析在 `@/server/app-search-permission/resolve`，按 AGENTS.md「源码架构」
 * （Worker 专属代码放 `src/server/`、路由保持精简）。
 *
 * 语义要点（fail-closed，INV-1 / INV-2）：
 * - 端点落在 legacy `/api/` 基，由 middleware 完整鉴权链看守（限流 / 封禁 /
 *   设备吊销 / `app:mobile:access`）；只有已通过 `app:mobile:access` 的登录凭证
 *   才能抵达本处理器。
 * - 角色不命中 = 200 双 false（这是**有效答案**，客户端据此禁用搜索且不重试）。
 * - 凭证无效 / 缺失 = 401（middleware 已挡，此处保底；触发客户端失败 + 退避重试）。
 * - DB 异常 = 500，**绝不**伪装成双 false（否则「服务端炸了」和「没权限」分不清，
 *   运维也无法从状态码区分）。
 *
 * 不属于 AppBookRequest 信封（`{code,data,msg}`），不进 OpenAPI 契约（AGENTS.md
 * 对 `/api/app/*` 的点名豁免同理）。运行时契约由
 * `tests/worker/app-search-permission.test.ts` 锁定。
 */

import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {resolveSearchPermission} from "@/server/app-search-permission/resolve";
import {jsonResponse} from "@/server/http";

const NO_STORE: ResponseInit["headers"] = {"cache-control": "no-store"};

export const GET: APIRoute = async ({request}) => {
  const outcome = await resolveSearchPermission(env.FEED_DB, request);

  switch (outcome.kind) {
    case "ok":
      return jsonResponse(
        {global: outcome.global, book: outcome.book},
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
