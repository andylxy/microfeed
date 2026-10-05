/**
 * 登录时间日志（ADR-0002）的跨端 DTO 与时间标签定义。
 *
 * 这些形状跨越服务端/客户端边界——`ajax/login-logs` 负责序列化，
 * `LoginLogsApp` 负责反序列化——所以统一放在 `src/shared/`
 * （两端都可导入的运行时中立层），而不是各写一份然后各自漂移
 * （AGENTS.md「源码架构」：React 客户端组件绝不能从 `src/server/` 导入）。
 *
 * 运行时中立是刻意的：不依赖 D1、不依赖 `cloudflare:workers`、不碰 DOM。
 */

/** 六个预设筛选窗口（ADR-0002 的「时间标签」）。`day` 键是接口参数值。 */
export const LOGIN_LOG_RANGES = {
  day: 1,
  week: 7,
  month: 30,
  quarter: 90,
  halfYear: 182,
  year: 365,
} as const;

export type LoginLogRange = keyof typeof LOGIN_LOG_RANGES;

/**
 * 登录日志看板的返回上限。
 *
 * 这是「找出启动过的 App」的排查视图，不是全量导出。服务端按它截断、客户端按它提示
 * 「已截断」，**两边必须是同一个数**，所以放在 shared 而不是各写一份（写两份迟早漂移）。
 */
export const LOGIN_LOG_MAX_ROWS = 500;

export const LOGIN_LOG_RANGE_KEYS = Object.keys(
  LOGIN_LOG_RANGES,
) as LoginLogRange[];

export function isLoginLogRange(value: string): value is LoginLogRange {
  return Object.prototype.hasOwnProperty.call(LOGIN_LOG_RANGES, value);
}

/**
 * 一行登录日志（每设备每自然日一行）。
 *
 * `loginAt` 是当天**最后一次**登录时间；`loginCount` 是当天登录**次数**
 * （需求 3 追加：每个 App 版本检查算一次登录）。
 *
 * ⚠️ `userId` / `userName` / `userEmail` 可空，而且**现在真的会为空**：写入方是匿名的
 * `/api/app/version`（App 冷启动的版本检查），未登录的启动同样要留下痕迹——这正是
 * 「找出启动过的 App」这条需求的关键。带了 Bearer 的检查会解析出用户并写入 `userId`。
 */
export interface LoginLogRow {
  deviceId: string;
  logDate: string;
  loginAt: string;
  loginCount: number;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
}
