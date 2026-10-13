/**
 * App 通道权限取值的共享部分：outcome 类型、失败形态工厂，以及「凭证 → 权限集合」链路。
 *
 * <p>名词解释查看与搜索是两个功能开关，判定逻辑同构：读 Bearer 令牌、校验令牌、
 * 解析权限集合、按权限码判布尔。本模块把同构部分集中成一份实现，
 * {@code mingci} 与 {@code search} 各只保留自己的权限码与结果字段。</p>
 *
 * <p><b>为什么返回值不带状态码</b>：本模块知道的是事实（有没有凭证、凭证有没有通过、
 * 权限集合里有没有这个码），而「事实该对应哪个 HTTP 状态码」是运输层的约定。
 * 分开之后，调用方可以是 HTTP 路由，也可以是将来的 RPC/队列消费者，不必各自重译。</p>
 *
 * <p><b>fail-closed</b>：拿不到确定的权限集合时一律返回 {@code resolution-failed} 或
 * {@code missing-bearer}，绝不返回「false」——那是「没有权限」的合法答案，
 * 用它冒充错误会让客户端永久禁用对应功能。</p>
 */

import {providedLoginCredentialBearer} from "@/server/auth/credential-login";
import {verifyLoginCredentialToken} from "@/server/auth/login-credentials";
import {resolveUserPermissions} from "@/server/rbac/resolve";

/**
 * 三种失败形态，「凭证 → 权限集合」链路与各功能开关的 outcome 共用一份：
 * - {@code missing-bearer} / {@code invalid-bearer}：请求本身没能说明「我是谁」→ 路由层 401；
 * - {@code resolution-failed}：说清楚了自己是谁，但服务端读不出权限 → 路由层 500。
 */
export type AppPermissionFailure =
  | {kind: "missing-bearer"}
  | {kind: "invalid-bearer"}
  | {kind: "resolution-failed"};

/**
 * 功能开关一次取值的结果，四种互斥形态：三种失败形态见 {@link AppPermissionFailure}，
 * {@code ok} 表示拿到了确定的权限集合，`T` 中的字段即为答案。
 */
export type AppPermissionOutcome<T> = ({kind: "ok"} & T) | AppPermissionFailure;

/** 「凭证 → 权限集合」链路的返回形态，即 outcome 在权限集合字段上的实例化。 */
export type AppPermissionSetOutcome = AppPermissionOutcome<{permissions: Set<string>}>;

/**
 * 一个 DB 故障归一成一个失败形态：异常细节只进日志，不进响应体。
 * `module` 决定日志前缀，`context` 自带动词，两者拼出日志行。
 */
function failed(context: string, error: unknown, module: string): AppPermissionFailure {
  console.error(`${module}: ${context}失败`, error);
  return {kind: "resolution-failed"};
}

/**
 * 解出当前凭证的权限集合，不判任何具体权限码。
 *
 * <p>凭证校验与权限解析都在这里完成，调用方拿到的是一份确定的权限集合，
 * 之后按自己的权限码判布尔即可。</p>
 */
export async function resolveAppPermissionSet(
  db: D1Database,
  request: Request,
  module: string,
): Promise<AppPermissionSetOutcome> {
  const token = providedLoginCredentialBearer(request);
  if (!token) return {kind: "missing-bearer"};

  let verified: Awaited<ReturnType<typeof verifyLoginCredentialToken>>;
  try {
    verified = await verifyLoginCredentialToken(db, token);
  } catch (error) {
    return failed("校验登录凭证令牌", error, module);
  }
  if (!verified) return {kind: "invalid-bearer"};

  let permissions: Set<string>;
  try {
    permissions = await resolveUserPermissions(db, verified.userId);
  } catch (error) {
    return failed("解析用户权限", error, module);
  }

  return {kind: "ok", permissions};
}
