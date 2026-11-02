/**
 * A6: stricter per-IP throttle for the username sign-in and change-password
 * endpoints.
 *
 * better-auth's `rateLimit.customRules` only covers `/sign-in/email` (5/60s);
 * the username variant and `change-password` fell through to the lax 100/60s
 * default, leaving a brute-force gap. Rather than edit the red-line
 * `better-auth.ts` (which would widen the upstream merge conflict), we intercept
 * at the single `/api/auth` throat — `src/pages/api/auth/[...all].ts` — one call
 * placed immediately before `auth.handler(request)`.
 *
 * The rule allows 5 attempts per 60s window per client address. Address
 * resolution is shared with the credential throttle (`client-address.ts`):
 * `cf-connecting-ip`, else the first `x-forwarded-for` hop, else **skip the IP
 * dimension entirely** (B13's decision, applied here for consistency — one
 * global bucket per endpoint would let a single client lock out every other
 * caller, which is a worse failure than an unthrottled request on a deployment
 * that never reports an address).
 *
 * 计数由 `server/rate-limit/window.ts` 的固定窗口原语承担；本文件只剩 HTTP
 * 这一层：路径白名单、地址解析与 429 响应。窗口键是「地址:路径」，分类由
 * `kind` 列区分，不再往 key 里塞命名空间前缀。
 *
 * 与凭证登录失败计数（`LOGIN_FAILURE`）的分工不变：这边数**已放行的尝试**、
 * 自己回 429；那边数**失败次数**、登录成功即清空。两者共用地址解析与窗口
 * 算术，不共用语义。
 */

import {clientAddress} from "@/server/auth/client-address";
import {AUTH_THROTTLE} from "@/server/rate-limit/kinds";
import {consumeWindow} from "@/server/rate-limit/window";

const THROTTLED_AUTH_PATHS = new Set([
  "/api/auth/sign-in/username",
  "/api/auth/change-password",
  // App 登录端点（工单 12）——与后台登录共用同一限流窗口策略。
  "/api/AppBookRequest/login",
  // 第三方登录端点（ADR-0013，见 AndroidProject-old 仓 docs/adr/0013-qq-third-party-login.md）
  // ——同款暴力破解防护。
  "/api/AppBookRequest/thirdPartyLogin",
  // 账号绑定（ADR-0014 I15）：这个端点校验**目标账号的口令**，是登录之外的第二个
  // 口令校验入口。不登记就等于全站唯一一个无限次撞库点，而它统一的失败文案
  // 「账号或密码错误」正好能拿来枚举账号是否存在。
  "/api/AppBookRequest/bindAccount",
]);

export async function enforceAuthEndpointThrottle(
  database: D1Database,
  request: Request,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  if (!THROTTLED_AUTH_PATHS.has(pathname)) return null;

  const ip = clientAddress(request);
  if (!ip) return null;

  const decision = await consumeWindow(
    database,
    AUTH_THROTTLE,
    `${ip}:${pathname}`,
  );
  if (decision.allowed) return null;

  return new Response("Too Many Requests", {
    headers: {
      "cache-control": "no-store",
      "retry-after": String(Math.max(1, decision.retryAfterSeconds)),
    },
    status: 429,
  });
}
