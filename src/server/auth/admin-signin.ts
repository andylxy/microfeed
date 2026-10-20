/**
 * 登录通道的「角色允许登录后台」门（后处理实现）。
 *
 * 背景：microfeed 的登录卡账号页走 better-auth 的 sign-in 端点，与登录凭证
 * （`credential-login.ts`，同一道门的前置实现）是两条独立通道。缺少这一门
 * 时，一个被关掉 `ext_roles.allow_admin_login` 的角色仍能凭正确密码拿到会话
 * cookie，然后每次请求都被 `middleware.ts` / `guard.ts` 弹成 403——账号既进
 * 不去，也看不到原因。这里把判定挪到发会话之前：不给它 cookie，直接回 403。
 *
 * 放在响应的后处理上有两个好处：① 只对**已经通过密码校验**的请求查角色，
 * 失败登录（密码错）仍然走统一的不对称错误，不泄露账号是否存在；② 不读
 * 请求体，与限流、CSRF 等既有前置互不干扰。
 *
 * 只服务后台账号。App 内容接口按登录凭证鉴权，与 `allow_admin_login` 无关
 * （见 `resolve.ts` 的 `userMayEnterAdmin` 注释）。
 */

import {userMayEnterAdmin} from "@/server/rbac/resolve";
import {publicLocalizedError} from "@/server/http";

/**
 * 走 better-auth `createAuthEndpoint` 成功分支的登录端点集合。三条路径的
 * 成功响应满足同一形态约定：**2xx + body 顶层带 `user`**——
 *   - `sign-in/email`、`sign-in/username`：`ctx.json({…, user})`
 *     （better-auth 的 sign-in / username 路由成功分支）
 *   - `passkey/verify-authentication`：`ctx.json({session, user})`
 *     （@better-auth/passkey 成功分支，随后 `setSessionCookie`）
 *
 * 登录卡只开放前两条（passkey 在该卡片仅注册/吊销，见 `AdminLoginApp.tsx`
 * 的说明），但第三条可被直连：不列进来，一个被关掉的角色就能绕过这道门拿到
 * cookie。后续给 better-auth 加登录型端点时，先把它的成功响应对照这条约定，
 * 再决定是否入列——形状不符的进不来（取不到 `user.id` 时放行原响应）。
 */
const ADMIN_SIGN_IN_PATHS = new Set([
  "/api/auth/sign-in/email",
  "/api/auth/sign-in/username",
  "/api/auth/passkey/verify-authentication",
]);

/**
 * 角色门的统一拒绝响应。两条登录通道（本条后处理通道与
 * `credential-login.ts` 的前置通道）共用，避免文案与状态码各自漂移——文案
 * 由 i18n 的 `errors.loginCredential.adminLoginDenied` 提供。
 */
export function adminLoginDeniedResponse(request: Request): Response {
  return publicLocalizedError(
    request,
    "errors.loginCredential.adminLoginDenied",
    403,
  );
}

/**
 * 对一条登录端点的成功响应补上角色门。判定不通过时返回 403，且**不带任何
 * `set-cookie`**——better-auth 已经在服务端建好会话行，但只要 cookie 不到
 * 浏览器，那个会话就用不出去；不带 cookie 的 403 也避免客户端把失败的登录
 * 当成成功、跟着跳转。
 */
export async function enforceAdminSignIn(
  request: Request,
  response: Response,
  db: D1Database,
): Promise<Response> {
  if (!ADMIN_SIGN_IN_PATHS.has(new URL(request.url).pathname)) {
    return response;
  }
  // 非 2xx = 登录失败（密码错、限流、封禁），交给 better-auth 的原始响应。
  if (!response.ok) {
    return response;
  }
  // better-auth 的登录成功体顶层带 `user`；取不到 id 时不做猜测，放行。
  const body = await response.clone().json().catch(() => null) as
    | {user?: {id?: unknown} | null}
    | null;
  const userId = typeof body?.user?.id === "string" ? body.user.id : null;
  if (!userId) {
    return response;
  }
  if (await userMayEnterAdmin(db, userId)) {
    return response;
  }
  return adminLoginDeniedResponse(request);
}
