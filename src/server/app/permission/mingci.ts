/**
 * 「当前账号能不能查看名词解释」的取值逻辑，G3 单开关 → 一个布尔 `allowed`。
 *
 * <p>放在 {@code src/server/}，因为它要用 Worker 绑定（D1）与令牌校验 ——
 * AGENTS.md「源码架构」把这类代码归到 {@code src/server/}，
 * 路由只负责把结果翻译成 HTTP（{@code src/pages/api/app/mingci-permission.ts}）。
 * 同层的 {@code @/server/app/permission/search} 也是「路由薄、逻辑在 server」的形态。</p>
 *
 * <p><b>为什么返回值不带状态码</b>：本模块知道的是事实（有没有凭证、凭证有没有通过、
 * 权限集合里有没有这个码），而「事实该对应哪个 HTTP 状态码」是运输层的约定。
 * 分开之后，调用方可以是 HTTP 路由，也可以是将来的 RPC/队列消费者，不必各自重译。</p>
 *
 * <p><b>fail-closed（INV-1 / INV-2）</b>：拿不到确定的权限集合时一律返回
 * {@code resolution-failed} 或 {@code missing-bearer}，<b>绝不</b>返回
 * {@code allowed: false}——那是「没有权限」的合法答案，用它冒充错误会让客户端永久禁用名词解释。</p>
 */

import {permissionsInclude} from "@/server/rbac/resolve";
import {PERMISSION_CODES} from "@/shared/Constants";
import {type AppPermissionOutcome, resolveAppPermissionSet} from "./resolve";

export type MingCiPermissionOutcome = AppPermissionOutcome<{allowed: boolean}>;

/**
 * 解出当前凭证对名词解释查看权限码 `app:mingci:view` 的持有情况。
 *
 * <p>权限码取自 {@link PERMISSION_CODES}（≡ {@code ext_permissions} 迁移 ≡ {@code seed.ts}
 * 三镜像），这里不写第四份字面量 —— 字面量漂移不会让任何测试变红，是最难查的一类 bug。</p>
 */
export async function resolveMingCiPermission(
  db: D1Database,
  request: Request,
): Promise<MingCiPermissionOutcome> {
  const set = await resolveAppPermissionSet(db, request, "app/mingci-permission");
  if (set.kind === "ok") {
    return {
      kind: "ok",
      allowed: permissionsInclude(set.permissions, PERMISSION_CODES.APP_MINGCI_VIEW),
    };
  }
  // 三种错误形态与 outcome 中逐字一致，直接透传即可。
  return set;
}
