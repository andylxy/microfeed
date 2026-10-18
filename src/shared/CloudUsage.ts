/**
 * 「Cloudflare 使用情况」仪表盘的跨端数据形状。
 *
 * 位置在 `src/shared/`：浏览器组件要读同一份形状，而 React 组件不得从
 * `src/server/` 导入（AGENTS.md「源码架构」）。同类先例是
 * `AppAnnouncement` / `AppLoginLog`。
 *
 * 所有时间字段都是带 `Z` 的 UTC ISO 串。前端一律用 `formatAdminDateTime`
 * （`src/client/admin-date-format.ts`）渲染，服务端不做时区换算。
 */

/** 单张指标卡。`limit` 为 null 表示没有官方限额（不画进度条）。 */
export interface UsageCard {
  /** 稳定键，前端据此选文案与单位 */
  key:
    | "d1Databases"
    | "d1RowsRead"
    | "d1RowsWritten"
    | "d1Storage"
    | "d1MeteredStorage"
    | "r2Storage"
    | "r2StorageGbMonth"
    | "r2ClassA"
    | "r2ClassB"
    | "workersRequests"
    | "workersErrors"
    | "workersSubrequests"
    | "workersCpuP99";
  value: number;
  limit: number | null;
  /** 额度文案（如 `5.00M` / `10 GB-month`），服务端格式化；`limit` 为 null 时无此项 */
  limitDisplay?: string;
  /**
   * 展示用字符串（如 `937.66k` / `44.51 MB` / `44,510 kB-mo` / `3.2 ms`）。
   * 由服务端格式化，前端不做单位换算。
   */
  display: string;
  /** 超额警示（仅 d1RowsWritten / workersRequests 可能触发，红色进度条） */
  overLimit: boolean;
  /** 口径附注的 i18n 键（可空） */
  noteKey?: string;
  /** 附注里的占位参数（如「其他操作 {{count}} 次」的次数） */
  noteParams?: Record<string, string | number>;
  /**
   * 数据截止时刻（UTC ISO 串）。存储类指标的最新一日没有数据时回退到最近有
   * 数据的一日，卡片据此附注「数据截至 X」。前端用 `formatAdminDateTime` 渲染。
   */
  asOfUtc?: string;
  /** 单卡不可用的原因（i18n 键）；有值时卡片显示「暂不可用」，不再显示数值 */
  unavailableKey?: string;
}

/** D1 趋势点：近 7 日读 / 写双线。`date` 为 UTC 日期 `YYYY-MM-DD`。 */
export interface D1TrendPoint {
  date: string;
  rowsRead: number;
  rowsWritten: number;
}

/** R2 趋势点：当月每日 Class A / B 双线。 */
export interface R2TrendPoint {
  date: string;
  classA: number;
  classB: number;
}

/** Workers 趋势点：近 7 日请求单线 + 错误。 */
export interface WorkersTrendPoint {
  date: string;
  requests: number;
  errors: number;
}

/**
 * 计费周期。Cloudflare 额度按 UTC 重置：日额度 UTC 00:00（北京时间 08:00），
 * 月额度 UTC 月首 00:00（北京时间每月 1 日 08:00）。
 */
export interface UsagePeriod {
  /** 周期开始（UTC ISO，含 Z） */
  startUtc: string;
  /** 周期结束（UTC ISO，含 Z，开区间） */
  endUtc: string;
  /** 下次额度重置时刻（UTC ISO，含 Z） */
  nextResetUtc: string;
}

/** 单个分区的可用性：false 时前端在该分区顶部展示降级条。 */
export interface UsageSection<T> {
  available: boolean;
  /** `available = false` 时的原因（i18n 键） */
  unavailableKey?: string;
  data: T | null;
}

export interface D1Usage {
  /** 计费周期（UTC 日；前端渲染为北京时间 08:00 ~ 次日 08:00） */
  period: UsagePeriod;
  cards: UsageCard[];
  trend: D1TrendPoint[];
}

export interface R2Usage {
  /** 计费周期（UTC 月；前端渲染为北京时间当月 1 日 08:00 ~ 次月 1 日 08:00） */
  period: UsagePeriod;
  cards: UsageCard[];
  trend: R2TrendPoint[];
}

export interface WorkersUsage {
  /** 计费周期（UTC 日；同 D1） */
  period: UsagePeriod;
  /** 实际生效的 scriptName 过滤；null = 账号级 */
  scriptName: string | null;
  cards: UsageCard[];
  trend: WorkersTrendPoint[];
}

export interface CloudUsageSnapshot {
  /** 设置页已保存 Token 且可解密；false 时前端整体走引导态 */
  configured: boolean;
  /**
   * 引导态细分原因：`undefined` = 未配置；`tokenDecryptFailed` = 密文不可解密
   * （KEK 轮换过），引导重新保存；`accountIdMissing` = 账号 ID 未配置。
   */
  unavailableKey?: string;
  /** 已配置 Token 的末四位提示（如 `…a1b2`）；不含密文或明文 */
  tokenHint?: string;
  /**
   * 数据抓取完成的时刻（UTC ISO 串）。周期边界用的是请求到达时刻，
   * 两者可差数秒——外网慢时不把结算日往后推。
   */
  fetchedAt: string;
  d1: UsageSection<D1Usage>;
  r2: UsageSection<R2Usage>;
  workers: UsageSection<WorkersUsage>;
}

/** 引导态 / 降级态的原因键。写在这里，服务端与前端共用同一组字符串。 */
export const CLOUD_USAGE_UNAVAILABLE = {
  /** 整体引导态：没有可用数据（未配置 / 解不开 / 账号 ID 缺失） */
  notConfigured: "notConfigured",
  tokenDecryptFailed: "tokenDecryptFailed",
  accountIdMissing: "accountIdMissing",
  graphqlFailed: "graphqlFailed",
  d1ListFailed: "d1ListFailed",
} as const;
