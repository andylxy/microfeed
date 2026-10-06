/**
 * 「当前账号能不能搜索」的取值逻辑，DESIGN §5.2。
 *
 * <p>放在 {@code src/server/} 而不是路由文件里，是因为它要用 Worker 绑定
 * （D1）与令牌校验 —— AGENTS.md「源码架构」要求这类代码落在 {@code src/server/}，
 * 而路由只负责把结果翻译成 HTTP（{@code src/pages/api/app/search-permission.ts}）。
 * 同层的 {@code @/server/app-announcement/store} 也是「路由薄、逻辑在 server」的形态。</p>
 *
 * <p><b>为什么返回值不带状态码</b>：本模块知道的是**事实**（有没有凭证、凭证有没有通过、
 * 权限集合里有没有这两个码），而「事实该对应哪个 HTTP 状态码」是运输层的约定。
 * 分开之后，调用方可以是 HTTP 路由，也可以是将来的 -. RPC/队列消费者，不必各自重译。</p>
 *
 * <p><b>fail-closed（INV-1 / INV-2）</b>：拿不到确定的权限集合时一律返回
 * {@code resolution-failed} 或 {@code missing-bearer}，<b>绝不</b>返回
 * “双 false”——那是「没有权限」的合法答案，用它冒充错误会让客户端永久禁用搜索。</p>
 */

import {providedLoginCredentialBearer} from "@/server/auth/credential-login";
import {verifyLoginCredentialToken} from "@/server/auth/login-credentials";
import {RBAC_WILDCARD, resolveUserPermissions} from "@/server/rbac/resolve";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * 一次取值的结果，四种互斥形态：
 * - {@code missing-bearer} / {@code invalid-bearer}：请求本身没能说明「我是谁」→ 路由层 401；
 * - {@code resolution-failed}：说清楚了自己是谁，但服务端读不出权限 → 路由层 500；
 * - {@code ok}：拿到了确定的权限集合，两个布尔即为答案（双 false 是「真的没权限」）。
 */
export type SearchPermissionOutcome =
  | {kind: "ok"; global: boolean; book: boolean}
  | {kind: "missing-bearer"}
  | {kind: "invalid-bearer"}
  | {kind: "resolution-failed"};

/** 一个 DB 故障笼统成一个失败形态：异常细节只进日志，**不**进响应体。 */
function failed(context: string, error: unknown): SearchPermissionOutcome {
  console.error(`app/search-permission: ${context}失败`, error);
  return {kind: "resolution-failed"};
}

/**
 * 解出当前凭证对两个搜索权限码的持有情况。
 *
 * <p>权限码取自 {@link PERMISSION_CODES}（≡ {@code ext_permissions} 迁移 ≡ {@code seed.ts}
 * 三镜像），这里不写第四份字面量 —— 字面量漂移不会让任何测试变红，是最难查的一类 bug。</p>
 */
export async function resolveSearchPermission(
  db: D1Database,
  request: Request,
): Promise<SearchPermissionOutcome> {
  const token = providedLoginCredentialBearer(request);
  if (!token) return {kind: "missing-bearer"};

  let verified: Awaited<ReturnType<typeof verifyLoginCredentialToken>>;
  try {
    verified = await verifyLoginCredentialToken(db, token);
  } catch (error) {
    return failed("校验登录凭证令牌", error);
  }
  if (!verified) return {kind: "invalid-bearer"};

  let permissions: Set<string>;
  try {
    permissions = await resolveUserPermissions(db, verified.userId);
  } catch (error) {
    return failed("解析用户权限", error);
  }

  // 多角色用户的权限是并集，`*` 通配短路。
  const has = (code: string): boolean =>
    permissions.has(code) || permissions.has(RBAC_WILDCARD);

  return {
    kind: "ok",
    global: has(PERMISSION_CODES.APP_SEARCH_GLOBAL),
    book: has(PERMISSION_CODES.APP_SEARCH_BOOK),
  };
}
