/**
 * 「当前凭证能不能取版本升级描述符」的取值逻辑。
 *
 * <p>放在 {@code src/server/}，因为它要用 Worker 绑定（D1）与令牌校验 ——
 * AGENTS.md「源码架构」把这类代码归到 {@code src/server/}，
 * 路由只负责把结果翻译成 HTTP（{@code src/pages/api/app/version.ts}）。
 * 同层的 {@code search} / {@code mingci} 也是「路由薄、逻辑在 server」的形态。</p>
 *
 * <p><b>为什么返回值不带状态码</b>：本模块知道的是事实（有没有凭证、凭证有没有通过、
 * 权限集合里有没有这个码），而「事实该对应哪个 HTTP 状态码」是运输层的约定。
 * 分开之后，调用方可以是 HTTP 路由，也可以是将来的 RPC/队列消费者，不必各自重译。</p>
 *
 * <p><b>为什么是 {@code {allowed}} 而不是直接给描述符</b>：与 {@code mingci} 同形 ——
 * resolver 只回答「允许吗」，「允许时给什么」是路由的事。</p>
 *
 * <p><b>fail-closed</b>：拿不到确定的权限集合时一律返回 {@code resolution-failed} 或
 * {@code missing-bearer}，<b>绝不</b>返回 {@code allowed: false} —— 那是「没有权限」的
 * 合法答案，用它冒充错误会让客户端把「服务端读不出权限」当成「永久禁止升级检查」。</p>
 */

import {permissionsInclude} from "@/server/rbac/resolve";
import {PERMISSION_CODES} from "@/shared/Constants";
import {type AppPermissionOutcome, resolveAppPermissionSet} from "./resolve";

export type VersionPermissionOutcome = AppPermissionOutcome<{allowed: boolean}>;

/**
 * 解出当前凭证对版本升级权限码 {@code app:version:read} 的持有情况。
 *
 * <p>权限码取自 {@link PERMISSION_CODES}（≡ {@code ext_permissions} 迁移 ≡ {@code seed.ts}
 * 三镜像），这里不写第四份字面量 —— 字面量漂移不会让任何测试变红，是最难查的一类 bug。</p>
 */
export async function resolveVersionPermission(
  db: D1Database,
  request: Request,
): Promise<VersionPermissionOutcome> {
  const set = await resolveAppPermissionSet(db, request, "app/version");
  if (set.kind === "ok") {
    return {
      kind: "ok",
      allowed: permissionsInclude(set.permissions, PERMISSION_CODES.APP_VERSION_READ),
    };
  }
  // 三种错误形态与 outcome 中逐字一致，直接透传即可。
  return set;
}
