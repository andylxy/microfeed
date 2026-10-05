/**
 * App 登录时间日志（ADR-0002）。
 *
 * <p>需求 3：「记录最后的登陆时间日志」，按 日 / 周 / 月 / 最近三个月 / 半年 / 年
 * 六个标签筛出「最近用过 App 的设备」。需求 3 追加（2026-10-04）：再加**登录次数**，
 * 「每个检查算一次登录」。</p>
 *
 * <p><b>写入时机</b>：{@code GET /api/app/version}（App 的版本检查）——即 App 每次
 * 启动的那一次检查记一条登录。放在这里而不是设备登记（`registerUserDevice`）有两个原因：
 * ① 登录次数的语义是「启动了几次」，而设备登记在**每个**鉴权请求上都会跑，在那里计数会
 * 变成「请求次数」；② 版本检查是**匿名**端点，未登录 / 纯离线读缓存的启动也能留下痕迹，
 * 而设备登记在身份验证之后，覆盖不到——那正是「找出启动过的 App」这条需求的关键。</p>
 *
 * <p><b>去重与计数</b>：行仍按 UNIQUE {@code (device_id, log_date)} 每设备每天一行
 * （需求「每天为 1 次」），但这一行现在**可累加**：首次插入 {@code login_count = 1}，
 * 之后同一设备同一天再检查则 {@code login_count + 1} 且 {@code login_at} 覆盖为最新。
 * 所以 {@code loginAt} 是当天**最后一次**登录时间，{@code loginCount} 是当天次数。
 * 注意去重靠的是这个 UNIQUE 索引，<b>不是</b>主键 {@code id}。</p>
 *
 * <p><b>为什么不复用 {@code ext_user_devices.last_seen_at}</b>：那张表每个设备
 * 永远只有一行、每次请求都被覆盖，能回答「现在活跃吗」，回答不了「最近三个月
 * 出现过哪几天」。需求要按区间回溯历史，必须按天累积。</p>
 *
 * <p>跨端 DTO（{@link LoginLogRow}、{@link LoginLogRange}）与时间标签定义放在
 * {@code @/shared/AppLoginLog}，好让 React 组件也能用而不必从 {@code src/server/}
 * 导入（AGENTS.md「源码架构」）。</p>
 */
import {
  isLoginLogRange,
  LOGIN_LOG_RANGES,
  LOGIN_LOG_RANGE_KEYS,
  type LoginLogRange,
  type LoginLogRow,
} from "@/shared/AppLoginLog";

// 同一模块只导入一次、再原样转出：既给调用方一个「服务端入口」，又不重复引用
// `@/shared/AppLoginLog`（导出与导入各写一遍是纯噪音）。
export {isLoginLogRange, LOGIN_LOG_RANGES, LOGIN_LOG_RANGE_KEYS};
export type {LoginLogRange, LoginLogRow};

/** UTC 日历日（`YYYY-MM-DD`）。与写入端 {@link recordLoginLog} 必须同源。 */
function utcDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/**
 * 确定性的行 id：同设备同一天永远得到同一个值（重放请求天然幂等）。
 *
 * <p>⚠️ **不能**把 `deviceId` 直接拼进 id 再 `replace(/[^A-Za-z0-9_]/g, "_")`：
 * `deviceIdFromRequest` 允许 `-` 和 `_`，而 `a-b` 与 `a_b` 规范化后都是 `a_b`
 * → 两台不同设备撞同一主键 → 第二个 `INSERT` 撞 `PRIMARY KEY(id)`。
 * 而 `ON CONFLICT (device_id, log_date) DO NOTHING` 只覆盖 UNIQUE 索引、
 * **不覆盖主键**，语句会抛错，且 `registerUserDevice` 没有 try，异常直接冒到
 * 鉴权链路变成 500。故这里对 id 做**保长度编码**：把 `-` 转成一个不会与
 * 原始字符混淆的转义序列（`_` → `__`、`-` → `_-`），保证单射。</p>
 */
function loginLogId(deviceId: string, logDate: string): string {
  // `_` 本身在 deviceId 中合法，故必须转义；`-` 不转义也不会与 `_` 混淆
  // （因为 `_` 已被转义成 `__`），但一并转义以保证「解码后等于原值」这一定义
  // 在字符集扩展后依然成立。
  const escaped = deviceId.replace(/_/g, "__").replace(/-/g, "_-");
  return `ll_${escaped}_${logDate.replace(/-/g, "")}`;
}

/**
 * 记一条「该设备今天登录过一次」。
 *
 * <p>同一设备同一自然日重复调用会**累加**：首次插入 {@code login_count = 1}，
 * 之后 {@code +1} 并把 {@code login_at} 覆盖为最新时间（需求 3 追加的
 * 「更新最后登录时间、登录次数加 1」）。行数不增长，所以「每天为 1 条」不变。</p>
 *
 * <p>{@code userId} 可以为 null（匿名启动的版本检查）。当已有的当天行是匿名写入、
 * 而这次带了用户时，用 {@code COALESCE} 把用户补上——同一天先匿名后登录很常见，
 * 不该因为先来的是匿名行就永久丢掉归属。</p>
 *
 * <p>⚠️ 主键 {@code id} 是「同设备同天恒定」的确定值，所以冲突时**不会**换 id；
 * 上面的 upsert 只更新 `login_at` / `login_count` / `user_id`。</p>
 */
export async function recordLoginLog(
  db: D1Database,
  userId: string | null,
  deviceId: string,
  now: number = Date.now(),
): Promise<void> {
  const logDate = utcDate(now);
  const loginAt = new Date(now).toISOString();
  await db
    .prepare(
      `INSERT INTO ext_app_login_log
         (id, user_id, device_id, log_date, login_at, login_count, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT (device_id, log_date) DO UPDATE SET
         login_at    = excluded.login_at,
         login_count = ext_app_login_log.login_count + 1,
         user_id     = COALESCE(excluded.user_id, ext_app_login_log.user_id)`,
    )
    .bind(loginLogId(deviceId, logDate), userId, deviceId, logDate, loginAt, loginAt)
    .run();
}

/**
 * 按时间标签读登录日志（默认按最近登录倒序）。
 *
 * <p>区间比较一律用 `login_at` 时间戳，**不**用 `log_date` 字符串拼接 ——
 * 后者是 UTC 日期，直接比较会在跨时区场景错位。</p>
 */
export async function listLoginLogs(
  db: D1Database,
  range: LoginLogRange,
  limit: number,
  now: number = Date.now(),
): Promise<LoginLogRow[]> {
  const days = LOGIN_LOG_RANGES[range];
  const since = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  const result = await db
    .prepare(
      `SELECT l.device_id      AS deviceId,
              l.log_date       AS logDate,
              l.login_at       AS loginAt,
              l.login_count    AS loginCount,
              l.user_id        AS userId,
              COALESCE(u.displayUsername, u.username) AS userName,
              u.email          AS userEmail
         FROM ext_app_login_log AS l
         LEFT JOIN auth_user AS u ON u.id = l.user_id
        WHERE l.login_at >= ?
        ORDER BY l.login_at DESC
        LIMIT ?`,
    )
    .bind(since, limit)
    .all<LoginLogRow>();
  return result.results ?? [];
}
