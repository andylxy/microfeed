/**
 * Canonical admin date/time rendering — one fixed numeric format everywhere.
 *
 * 站点要求（2026-10-14，见 AGENTS.md「管理后台国际化」）：后台**所有**日期/时间显示统一为
 * `2026-10-14 11:29:42`（24 小时制，本地时区），不再随语言或操作系统变化。
 *
 * 为什么不用 Intl / `toLocaleString()`：它们随 locale 变（中英下不同，`en` 还带
 * AM/PM），同一个后台在两台机器上会渲染成两种样子；审计、日志这类要「对齐着看」的
 * 时间尤其不能这样。数字格式本身与语言无关，所以这里直接拼字符串。
 *
 * 本地时区：`getFullYear()` 等按运行环境时区求值——浏览器里就是管理员所在时区，
 * 这正是看日志时想要的。注意因此不要在任何服务端渲染路径里用它（workerd 是 UTC）。
 */

/** `0` -> `"00"`. */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** Parse to a valid Date, or `null` for anything unparseable. */
function toDate(value: Date | number | string): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** `2026-10-14 11:29:42`. Empty string for an unparseable value. */
export function formatAdminDateTime(value: Date | number | string): string {
  const date = toDate(value);
  if (!date) return "";
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    ` ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}
