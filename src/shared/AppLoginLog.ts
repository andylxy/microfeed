/**
 * 登录时间日志（ADR-0002）的跨端 DTO 与时间窗口定义。
 *
 * 这些形状跨越服务端/客户端边界——`ajax/login-logs` 负责序列化，
 * `LoginLogsApp` 负责反序列化——所以统一放在 `src/shared/`
 * （两端都可导入的运行时中立层），而不是各写一份然后各自漂移
 * （AGENTS.md「源码架构」：React 客户端组件绝不能从 `src/server/` 导入）。
 *
 * 运行时中立是刻意的：不依赖 D1、不依赖 `cloudflare:workers`、不碰 DOM。
 */

/**
 * 日期时间窗口：毫秒时间戳，比较区间为半开区间 `[fromMs, toMs)`。
 *
 * 缺省的一端表示这一侧不设限——运维只想看「某天之后」时，不必再补一个人为的
 * 截止值。服务端把毫秒换算成 `login_at`（ISO 字符串）后再比较，**不**用
 * `log_date`（UTC 日历日字符串）直接比，后者会在跨时区场景错位。
 */
export interface LoginLogWindow {
  fromMs?: number | null;
  toMs?: number | null;
}

/**
 * 登录日志看板的返回上限。
 *
 * 这是「找出启动过的 App」的排查视图，不是全量导出。服务端按它截断、客户端按它提示
 * 「已截断」，**两边必须是同一个数**，所以放在 shared 而不是各写一份（写两份迟早漂移）。
 */
export const LOGIN_LOG_MAX_ROWS = 500;

/**
 * 一行登录日志（每设备每自然日一行）。
 *
 * `loginAt` 是当天**最后一次**登录时间；`loginCount` 是当天登录**次数**
 * （需求 3 追加：每个 App 版本检查算一次登录）。
 *
 * ⚠️ `userName` / `userEmail` 可空：`auth_user` 里的 `username` 与
 * `displayUsername` 都可以为空（真实库里大多数账号只有邮箱），所以**不能**把
 * 「没有用户名」当成「没有账号」——这正是看板一度把整列显示成「未登录」的原因。
 * 显示方必须落到 `userId` 上（与设备看板 `{@link AdminDeviceRow}` 的
 * `username ?? userId` 同一个办法）。
 *
 * `userId` 为 null 表示这条日志确实出自匿名启动；只有当设备表里有该设备的
 * 绑定账号时才会被回查填补，见 {@link listLoginLogs}。
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
