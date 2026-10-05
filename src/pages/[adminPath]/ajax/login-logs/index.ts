/**
 * Login-log board read endpoint (`/admin/login-logs/`).
 *
 * `GET ?range=day|week|month|quarter|halfYear|year` returns the devices that
 * logged in inside the selected rolling window, newest first (ADR-0002's six
 * time tags). The window is compared on `login_at`, never on the `log_date`
 * string, so a timezone difference cannot shift a device in or out.
 *
 * Guarded by `system:login-log:read` — the same code its menu row binds.
 */
import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {
  isLoginLogRange,
  listLoginLogs,
  LOGIN_LOG_RANGES,
  type LoginLogRange,
} from "@/server/app-version/login-log";
import {jsonResponse} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {LOGIN_LOG_MAX_ROWS} from "@/shared/AppLoginLog";
import {PERMISSION_CODES} from "@/shared/Constants";

/** 未传 `limit` 时的默认条数；上限见 {@link LOGIN_LOG_MAX_ROWS}（与客户端共用）。 */
const DEFAULT_LIMIT = 200;

export const GET: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.SYSTEM_LOGIN_LOG_READ,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;

  const params = new URL(request.url).searchParams;
  const requested = params.get("range") ?? "";
  // 未知标签直接 400，**不**静默回落成「日」：回落会让运维以为看到的是全量，
  // 而实际只是最近 1 天——这是比报错更坏的结果。缺省（未传参数）才等于日。
  if (requested !== "" && !isLoginLogRange(requested)) {
    return jsonResponse(
      {error: `unknown range: ${requested}`},
      {status: 400, headers: {"cache-control": "private, no-store"}},
    );
  }
  const range: LoginLogRange = isLoginLogRange(requested) ? requested : "day";

  const limit = Math.min(
    Math.max(Number(params.get("limit")) || DEFAULT_LIMIT, 1),
    LOGIN_LOG_MAX_ROWS,
  );
  const rows = await listLoginLogs(env.FEED_DB, range, limit);

  return jsonResponse(
    {range, days: LOGIN_LOG_RANGES[range], rows},
    {headers: {"cache-control": "private, no-store"}},
  );
};
