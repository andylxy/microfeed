/**
 * Cloudflare 免费额度的常量，一处集中。
 *
 * 账号升级到 Paid 后只改本文件：卡片标题与进度条分母都读这里，页面其他位置
 * 不再出现第二份数字。
 *
 * 官方出处（2026-10-18 核验）：
 *   D1    https://developers.cloudflare.com/d1/platform/limits/
 *         https://developers.cloudflare.com/d1/platform/pricing/
 *   R2    https://developers.cloudflare.com/r2/pricing/
 *   Workers https://developers.cloudflare.com/workers/platform/pricing/
 */

/** D1 免费额度。`rowsRead` 计的是扫描行数，不是返回行数。 */
export const D1_FREE_LIMITS = {
  /** 账号内数据库个数 */
  databases: 10,
  /** 每日读取行数（UTC 00:00 重置，即北京时间 08:00） */
  rowsReadPerDay: 5_000_000,
  /** 每日写入行数（同上） */
  rowsWrittenPerDay: 100_000,
  /** 账号总储存（单库上限 500 MB 写在卡片附注文案里，不在这里重复一份） */
  storageBytesPerAccount: 5 * 1024 ** 3,
} as const;

/** R2 免费额度。操作计费是账号级、按月累计。 */
export const R2_FREE_LIMITS = {
  /** 每月存储（GB-month） */
  storageGbMonth: 10,
  /** 每月 Class A 操作次数 */
  classAOperationsPerMonth: 1_000_000,
  /** 每月 Class B 操作次数 */
  classBOperationsPerMonth: 10_000_000,
} as const;

/**
 * GB-month 的折算天数。官方定价页的定义是「当月每日峰值求和 ÷ 30」，
 * 这个 30 是固定除数，与当月实际天数无关。
 */
export const R2_GB_MONTH_DIVISOR = 30;

/**
 * 「计量存储」的折算除数（拍板 A1）：当前 UTC 月每日 `max{databaseSizeBytes}`
 * 求和 ÷ 1024 得 kB-mo。官方未公开该字段的口径，折算值与控制台的
 * 「Metered storage」不可比，卡片附注必须写明以控制台为准。
 */
export const D1_METERED_STORAGE_DIVISOR = 1024;

/**
 * Workers 免费额度。子请求不计费；单次 CPU 上限不作为卡片限额（卡片只展示
 * P99 实测值），其 10 毫秒写在 `cloudUsage.note.workersCpuP99` 的附注文案里。
 */
export const WORKERS_FREE_LIMITS = {
  /** 每日请求数（UTC 00:00 重置） */
  requestsPerDay: 100_000,
} as const;
