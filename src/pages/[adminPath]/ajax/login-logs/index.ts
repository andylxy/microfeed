/**
 * Login-log board read endpoint (`/admin/login-logs/`).
 *
 * `GET ?from=<ms>&to=<ms>` returns the devices that logged in inside the given
 * window, newest first. Both bounds are optional millisecond timestamps, and the
 * optional side simply stays unlimited. The window is compared on `login_at`,
 * never on the `log_date` string, so a timezone difference cannot shift a device
 * in or out.
 *
 * Guarded by `system:login-log:read` — the same code its menu row binds.
 */
import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {listLoginLogs} from "@/server/app-version/login-log";
import {jsonResponse} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {LOGIN_LOG_MAX_ROWS} from "@/shared/AppLoginLog";
import {PERMISSION_CODES} from "@/shared/Constants";

/** 未传 `limit` 时的默认条数；上限见 {@link LOGIN_LOG_MAX_ROWS}（与客户端共用）。 */
const DEFAULT_LIMIT = 200;

/** 这个看板是给运维排查用的实时视图，任何中间层都不该替他留副本。 */
const NO_STORE = {"cache-control": "private, no-store"};

/**
 * 读毫秒时间戳边界。返回值区分**三种**情形，缺一不可：
 * `{}` = 没传这一侧（该侧不设限）、`{value}` = 传了、`{invalid: true}` = 传了但不是数字。
 *
 * 「没传」和「传了非法值」必须分开：把它们都当成「不设限」，会让运维以为自己在看
 * 全区间，而实际得到了他没要求的另一份数据——这正是原来那条注释反对的静默回落。
 */
function readBound(raw: string | null): {value?: number; invalid?: boolean} {
  if (raw === null || raw === "") return {};
  const value = Number(raw);
  if (!Number.isFinite(value)) return {invalid: true};
  return {value};
}

export const GET: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.SYSTEM_LOGIN_LOG_READ,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;

  const params = new URL(request.url).searchParams;
  const from = readBound(params.get("from"));
  const to = readBound(params.get("to"));
  // 非法参数与「起点晚于终点」都直接 400：悄悄换成「不限时间」会让看板看起来是
  // 全量，而实际是一份没人要求的结果，比报错更难发现。
  if (from.invalid || to.invalid) {
    return jsonResponse(
      {error: "from and to must be millisecond timestamps"},
      {status: 400, headers: NO_STORE},
    );
  }
  if (from.value != null && to.value != null && from.value > to.value) {
    return jsonResponse(
      {error: "from must not be later than to"},
      {status: 400, headers: NO_STORE},
    );
  }

  const limit = Math.min(
    Math.max(Number(params.get("limit")) || DEFAULT_LIMIT, 1),
    LOGIN_LOG_MAX_ROWS,
  );
  const rows = await listLoginLogs(
    env.FEED_DB,
    {fromMs: from.value, toMs: to.value},
    limit,
  );

  // 只回行数组：窗口由调用方自己发来的参数决定，回显它没有任何消费方，
  // 反而多一份字段需要长期兼容（这是个内部 ajax，改动自由，不必留僵尸字段）。
  return jsonResponse({rows}, {headers: NO_STORE});
};
