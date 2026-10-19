/**
 * 「Cloudflare 使用情况」快照的组装层。
 *
 * 输入是一个 Token 三态判定加两次官方接口调用，输出一份前端可以直接渲染的
 * {@link CloudUsageSnapshot}：三分区各自的计费周期、卡片（数值与额度都已格式化成
 * display 字符串）、趋势点。
 *
 * 三条约束：
 *   1. 不读业务表——D1 代价只有 Token 单行 1 行；
 *   2. 服务端只认 UTC，周期边界用 `Date.UTC(...)` 构造，下发带 `Z` 的 ISO 串，
 *      换算只在前端发生；
 *   3. 任何 Cloudflare 侧故障都不影响后台其他页面，失败只坏自己一页。
 */
import {
  fetchUsageGraphQL,
  listD1Databases,
  utcDateOf,
  type UsageGraphQLPayload,
  type UsageQueryWindow,
} from "@/server/cloud-usage/CloudflareClient";
import {
  D1_METERED_STORAGE_DIVISOR,
  D1_FREE_LIMITS,
  R2_FREE_LIMITS,
  R2_GB_MONTH_DIVISOR,
  WORKERS_FREE_LIMITS,
} from "@/server/cloud-usage/limits";
import {classifyR2Action} from "@/server/cloud-usage/r2-classes";
import {
  readCloudflareToken,
  type CloudUsageTokenEnv,
} from "@/server/cloud-usage/token-store";
import {
  CLOUD_USAGE_UNAVAILABLE,
  type CloudUsageSnapshot,
  type D1TrendPoint,
  type D1Usage,
  type R2TrendPoint,
  type R2Usage,
  type UsageCard,
  type UsagePeriod,
  type UsageSection,
  type WorkersTrendPoint,
  type WorkersUsage,
} from "@/shared/CloudUsage";

/** 本模块用到的绑定：Token 存取的两个，加上账号 ID 与 Worker 名。 */
export interface CloudUsageEnv extends CloudUsageTokenEnv {
  MICROFEED_CLOUDFLARE_ACCOUNT_ID?: string;
  MICROFEED_WORKER_NAME?: string;
}

const DAY_MS = 86_400_000;

/** 趋势窗口天数（含今天）。官方指标保留 31 天，7 日窗口安全。 */
const TREND_DAYS = 7;

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** UTC 当日 00:00 的毫秒值。 */
function utcMidnight(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** UTC 当月 1 日 00:00 的毫秒值。 */
function utcMonthStart(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

/** 日分区周期：当日 00:00Z ~ 次日 00:00Z，下次重置 = 次日 00:00Z。 */
function dailyPeriod(now: Date): UsagePeriod {
  const start = utcMidnight(now);
  const end = start + DAY_MS;
  return {
    startUtc: new Date(start).toISOString(),
    endUtc: new Date(end).toISOString(),
    nextResetUtc: new Date(end).toISOString(),
  };
}

/** 月分区周期：当月 1 日 00:00Z ~ 次月 1 日 00:00Z。 */
function monthlyPeriod(now: Date): UsagePeriod {
  const start = utcMonthStart(now);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return {
    startUtc: new Date(start).toISOString(),
    endUtc: new Date(end).toISOString(),
    nextResetUtc: new Date(end).toISOString(),
  };
}

function queryWindow(now: Date, scriptName: string | null): UsageQueryWindow {
  const today = utcMidnight(now);
  const firstTrendDay = today - (TREND_DAYS - 1) * DAY_MS;
  const monthStart = utcMonthStart(now);
  return {
    dayFromDate: utcDate(firstTrendDay),
    dayToDate: utcDate(today),
    monthFromDate: utcDate(monthStart),
    dayFromIso: new Date(firstTrendDay).toISOString(),
    monthFromIso: new Date(monthStart).toISOString(),
    nowIso: now.toISOString(),
    scriptName,
  };
}

/** `1234567` -> `1.23M`；`12345` -> `12.35k`。 */
function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}k`;
  return String(Math.round(value));
}

/** 字节数按 1024 进制换算，保留两位小数。 */
function bytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${amount.toFixed(2)} ${units[unitIndex]}`;
}

/** 额度文案，与数值分开传：卡片上的「免费额度」用的是同一套格式化规则。 */
interface CardLimits {
  limit: number | null;
  limitDisplay?: string;
}

function card(
  key: UsageCard["key"],
  value: number,
  limits: CardLimits,
  display: string,
  extra: Pick<UsageCard, "noteKey" | "noteParams" | "asOfUtc" | "unavailableKey"> = {},
): UsageCard {
  return {
    key,
    value,
    limit: limits.limit,
    limitDisplay: limits.limitDisplay,
    display,
    overLimit: limits.limit !== null && value > limits.limit,
    ...extra,
  };
}

/** 单卡不可用：数值留 0，display 用破折号，进度条自然为 0%。 */
function unavailableCard(
  key: UsageCard["key"],
  limits: CardLimits,
  reasonKey: string,
): UsageCard {
  return card(key, 0, limits, "—", {unavailableKey: reasonKey});
}

/**
 * 取到数就出正常卡，没取到就出「不可用」卡。
 *
 * `value` 为 `null` 表示这一项没取到数——与「取到了，就是 0」是两件事：0 画成
 * 空进度条，null 画成破折号并带原因，运维不会把两者看混。`display` 只在有值
 * 时才调用，所以格式化函数里不必再判空。
 */
function cardOrUnavailable(
  key: UsageCard["key"],
  value: number | null,
  limits: CardLimits,
  display: (value: number) => string,
  reasonKey: string,
  extra: Pick<UsageCard, "noteKey" | "noteParams" | "asOfUtc"> = {},
): UsageCard {
  return value === null
    ? unavailableCard(key, limits, reasonKey)
    : card(key, value, limits, display(value), extra);
}

function emptySection<T>(reasonKey: string): UsageSection<T> {
  return {available: false, unavailableKey: reasonKey, data: null};
}

/** 按日期聚合的累加器，供三个分区的趋势共用。 */
function addTo(map: Map<string, number>, date: string, amount: number): void {
  map.set(date, (map.get(date) ?? 0) + amount);
}

/** 从 `fromDate` 到 `toDate`（含两端）逐日展开，缺失的日期补 0。 */
function dateRange(fromDate: string, toDate: string): string[] {
  const dates: string[] = [];
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  for (let cursor = from; cursor <= to; cursor += DAY_MS) {
    dates.push(utcDate(cursor));
  }
  return dates;
}

/** 某日 00:00Z 的 ISO 串，用于卡片的「数据截至」附注；日期不可解析时不给附注。 */
function startOfUtcDateIso(date: string): string | undefined {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** 一行按日的实体容量读数。 */
interface DailyEntitySize {
  /** UTC 日期 `YYYY-MM-DD` */
  date: string;
  /** 库名 / 桶名 */
  entity: string;
  /** 该日该实体的容量（字节） */
  size: number;
}

interface DailyEntityPeaks {
  /** 日 → 实体 → 该日峰值 */
  byDate: Map<string, Map<string, number>>;
  /** 最新有数据的一日；一天都没有时为 undefined */
  latestDate?: string;
  /** `latestDate` 当日全部实体求和 */
  latestDayTotal: number;
  /** 所有有数据的日期求和 */
  allDaysTotal: number;
}

/**
 * 按日聚合「实体容量」：同一天同一个实体取最大值，再逐日求和。
 *
 * D1（按库）与 R2（按桶）用的是同一套口径，差别只在取哪几个字段，
 * 所以聚合只有这一份；两处各写一遍会让两个口径各自演化、逐渐对不上。
 */
function dailyEntityPeaks(rows: DailyEntitySize[]): DailyEntityPeaks {
  const byDate = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const perEntity = byDate.get(row.date) ?? new Map<string, number>();
    perEntity.set(row.entity, Math.max(perEntity.get(row.entity) ?? 0, row.size));
    byDate.set(row.date, perEntity);
  }
  const dates = [...byDate.keys()].sort();
  const latestDate = dates[dates.length - 1];
  let latestDayTotal = 0;
  for (const size of (latestDate ? byDate.get(latestDate)?.values() : undefined) ?? []) {
    latestDayTotal += size;
  }
  let allDaysTotal = 0;
  for (const perEntity of byDate.values()) {
    for (const size of perEntity.values()) allDaysTotal += size;
  }
  return {byDate, latestDate, latestDayTotal, allDaysTotal};
}

const D1_DATABASE_LIMIT: CardLimits = {
  limit: D1_FREE_LIMITS.databases,
  limitDisplay: String(D1_FREE_LIMITS.databases),
};
const D1_ROWS_READ_LIMIT: CardLimits = {
  limit: D1_FREE_LIMITS.rowsReadPerDay,
  limitDisplay: compact(D1_FREE_LIMITS.rowsReadPerDay),
};
const D1_ROWS_WRITTEN_LIMIT: CardLimits = {
  limit: D1_FREE_LIMITS.rowsWrittenPerDay,
  limitDisplay: compact(D1_FREE_LIMITS.rowsWrittenPerDay),
};
const D1_STORAGE_LIMIT: CardLimits = {
  limit: D1_FREE_LIMITS.storageBytesPerAccount,
  limitDisplay: bytes(D1_FREE_LIMITS.storageBytesPerAccount),
};
const NO_LIMIT: CardLimits = {limit: null};
const R2_GB_MONTH_LIMIT: CardLimits = {
  limit: R2_FREE_LIMITS.storageGbMonth,
  limitDisplay: `${R2_FREE_LIMITS.storageGbMonth} GB-month`,
};
const R2_CLASS_A_LIMIT: CardLimits = {
  limit: R2_FREE_LIMITS.classAOperationsPerMonth,
  limitDisplay: compact(R2_FREE_LIMITS.classAOperationsPerMonth),
};
const R2_CLASS_B_LIMIT: CardLimits = {
  limit: R2_FREE_LIMITS.classBOperationsPerMonth,
  limitDisplay: compact(R2_FREE_LIMITS.classBOperationsPerMonth),
};
const WORKERS_REQUESTS_LIMIT: CardLimits = {
  limit: WORKERS_FREE_LIMITS.requestsPerDay,
  limitDisplay: compact(WORKERS_FREE_LIMITS.requestsPerDay),
};

/**
 * D1 分区：库数来自 REST，读写与存储来自 GraphQL。
 *
 * REST 只承载「数据库总数」一张卡，它失败时只降级这一张，其余卡片照常。
 */
function assembleD1(
  period: UsagePeriod,
  window: UsageQueryWindow,
  payload: UsageGraphQLPayload,
  databaseCount: number | null,
): UsageSection<D1Usage> {
  const analytics = payload.d1Analytics;
  const storage = payload.d1Storage;
  // 分区降级的粒度比规格更细：只有整区两份数据都缺才把分区标成不可用；
  // 缺其中一份时分区保留，缺的那几张卡各自标「暂不可用」。这样一次部分失败
  // 只损失它真正影响到的数字，其余照常显示。
  if (!analytics && !storage) {
    return emptySection(CLOUD_USAGE_UNAVAILABLE.graphqlFailed);
  }

  const today = window.dayToDate;
  const readTrend = new Map<string, number>();
  const writeTrend = new Map<string, number>();
  let rowsReadToday = 0;
  let rowsWrittenToday = 0;
  for (const row of analytics ?? []) {
    addTo(readTrend, row.date, row.rowsRead);
    addTo(writeTrend, row.date, row.rowsWritten);
    if (row.date === today) {
      rowsReadToday += row.rowsRead;
      rowsWrittenToday += row.rowsWritten;
    }
  }

  // 每个 (date, databaseId) 取该日最大库容量；卡片取最新有数据的一日逐库求和。
  const storagePeaks = dailyEntityPeaks(
    (storage ?? []).map((row) => ({
      date: row.date,
      entity: row.databaseId,
      size: row.databaseSizeBytes,
    })),
  );
  const latestStorageDate = storagePeaks.latestDate;
  const totalStorage = storagePeaks.latestDayTotal;
  // 计量存储（拍板 A1）：当月每日逐库求和，再把每日总量相加，除以 1024。
  const meteredKbMonth = storagePeaks.allDaysTotal / D1_METERED_STORAGE_DIVISOR;

  const cards: UsageCard[] = [
    cardOrUnavailable(
      "d1Databases",
      databaseCount,
      D1_DATABASE_LIMIT,
      String,
      CLOUD_USAGE_UNAVAILABLE.d1ListFailed,
    ),
    cardOrUnavailable(
      "d1RowsRead",
      analytics ? rowsReadToday : null,
      D1_ROWS_READ_LIMIT,
      compact,
      CLOUD_USAGE_UNAVAILABLE.graphqlFailed,
      {noteKey: "cloudUsage.note.d1RowsRead"},
    ),
    cardOrUnavailable(
      "d1RowsWritten",
      analytics ? rowsWrittenToday : null,
      D1_ROWS_WRITTEN_LIMIT,
      compact,
      CLOUD_USAGE_UNAVAILABLE.graphqlFailed,
    ),
    cardOrUnavailable(
      "d1Storage",
      storage ? totalStorage : null,
      D1_STORAGE_LIMIT,
      bytes,
      CLOUD_USAGE_UNAVAILABLE.graphqlFailed,
      {
        noteKey: "cloudUsage.note.d1Storage",
        asOfUtc: !latestStorageDate || latestStorageDate === today
          ? undefined
          : startOfUtcDateIso(latestStorageDate),
      },
    ),
    cardOrUnavailable(
      "d1MeteredStorage",
      storage ? meteredKbMonth : null,
      NO_LIMIT,
      (value) => `${Math.round(value)} kB-mo`,
      CLOUD_USAGE_UNAVAILABLE.graphqlFailed,
      {noteKey: "cloudUsage.note.d1MeteredStorage"},
    ),
  ];

  const trend: D1TrendPoint[] = dateRange(window.dayFromDate, window.dayToDate)
    .map((date) => ({
      date,
      rowsRead: readTrend.get(date) ?? 0,
      rowsWritten: writeTrend.get(date) ?? 0,
    }));

  return {available: true, data: {period, cards, trend}};
}

/**
 * R2 分区：操作按官方三份清单归类，存储取最新一日逐桶求和，GB-month 按
 * 官方公式「当月每日峰值求和 ÷ 30」。
 */
function assembleR2(
  period: UsagePeriod,
  window: UsageQueryWindow,
  payload: UsageGraphQLPayload,
): UsageSection<R2Usage> {
  const operations = payload.r2Operations;
  const storage = payload.r2Storage;
  if (!operations && !storage) {
    return emptySection(CLOUD_USAGE_UNAVAILABLE.graphqlFailed);
  }

  let classA = 0;
  let classB = 0;
  let other = 0;
  const trendA = new Map<string, number>();
  const trendB = new Map<string, number>();
  for (const row of operations ?? []) {
    const date = utcDateOf(row.datetime);
    switch (classifyR2Action(row.actionType)) {
      case "A":
        classA += row.requests;
        addTo(trendA, date, row.requests);
        break;
      case "B":
        classB += row.requests;
        addTo(trendB, date, row.requests);
        break;
      case "free":
        break;
      default:
        other += row.requests;
    }
  }

  // 每个 (datetime, bucketName) 取该时刻的峰值；按日逐桶求和后取最新一日。
  const storagePeaks = dailyEntityPeaks(
    (storage ?? []).map((row) => ({
      date: utcDateOf(row.datetime),
      entity: row.bucketName,
      size: row.payloadSize + row.metadataSize,
    })),
  );
  const latestStorageDate = storagePeaks.latestDate;
  const currentBytes = storagePeaks.latestDayTotal;
  const gbMonth = storagePeaks.allDaysTotal / (1024 ** 3) / R2_GB_MONTH_DIVISOR;

  const cards: UsageCard[] = [
    cardOrUnavailable(
      "r2Storage",
      storage ? currentBytes : null,
      NO_LIMIT,
      bytes,
      CLOUD_USAGE_UNAVAILABLE.graphqlFailed,
      {
        asOfUtc: !latestStorageDate || latestStorageDate === window.dayToDate
          ? undefined
          : startOfUtcDateIso(latestStorageDate),
      },
    ),
    cardOrUnavailable(
      "r2StorageGbMonth",
      storage ? gbMonth : null,
      R2_GB_MONTH_LIMIT,
      (value) => `${value.toFixed(2)} GB-month`,
      CLOUD_USAGE_UNAVAILABLE.graphqlFailed,
    ),
    cardOrUnavailable(
      "r2ClassA",
      operations ? classA : null,
      R2_CLASS_A_LIMIT,
      compact,
      CLOUD_USAGE_UNAVAILABLE.graphqlFailed,
      // 「清单外操作」的计数只挂在 Class A 卡上：两张卡共用同一个 `other` 计数，
      // 各挂一次会让同一句附注在页面上重复出现两遍。
      {noteKey: "cloudUsage.note.r2Operations", noteParams: {count: other}},
    ),
    cardOrUnavailable(
      "r2ClassB",
      operations ? classB : null,
      R2_CLASS_B_LIMIT,
      compact,
      CLOUD_USAGE_UNAVAILABLE.graphqlFailed,
    ),
  ];

  const trend: R2TrendPoint[] = dateRange(window.monthFromDate, window.dayToDate)
    .map((date) => ({
      date,
      classA: trendA.get(date) ?? 0,
      classB: trendB.get(date) ?? 0,
    }));

  return {available: true, data: {period, cards, trend}};
}

/** Workers 分区。`scriptName` 为 null 时统计为账号级，卡片附注说明这一点。 */
function assembleWorkers(
  period: UsagePeriod,
  window: UsageQueryWindow,
  payload: UsageGraphQLPayload,
): UsageSection<WorkersUsage> {
  const invocations = payload.workersInvocations;
  if (!invocations) {
    return emptySection(CLOUD_USAGE_UNAVAILABLE.graphqlFailed);
  }

  const today = window.dayToDate;
  const requestTrend = new Map<string, number>();
  const errorTrend = new Map<string, number>();
  let requestsToday = 0;
  let errorsToday = 0;
  let subrequestsToday = 0;
  let cpuP99Today = 0;
  for (const row of invocations) {
    const date = utcDateOf(row.datetime);
    addTo(requestTrend, date, row.requests);
    addTo(errorTrend, date, row.errors);
    if (date === today) {
      requestsToday += row.requests;
      errorsToday += row.errors;
      subrequestsToday += row.subrequests;
      cpuP99Today = Math.max(cpuP99Today, row.cpuTimeP99);
    }
  }

  const accountWide = window.scriptName === null;
  const cards: UsageCard[] = [
    card("workersRequests", requestsToday, WORKERS_REQUESTS_LIMIT, compact(requestsToday), {
      noteKey: accountWide ? "cloudUsage.note.workersAccountWide" : undefined,
    }),
    card("workersErrors", errorsToday, NO_LIMIT, compact(errorsToday)),
    card("workersSubrequests", subrequestsToday, NO_LIMIT, compact(subrequestsToday), {
      noteKey: "cloudUsage.note.workersSubrequests",
    }),
    card("workersCpuP99", cpuP99Today, NO_LIMIT, `${cpuP99Today.toFixed(1)} ms`, {
      noteKey: "cloudUsage.note.workersCpuP99",
    }),
  ];

  const trend: WorkersTrendPoint[] = dateRange(window.dayFromDate, window.dayToDate)
    .map((date) => ({
      date,
      requests: requestTrend.get(date) ?? 0,
      errors: errorTrend.get(date) ?? 0,
    }));

  return {
    available: true,
    data: {period, scriptName: window.scriptName, cards, trend},
  };
}

/** 引导态快照：没有数据，但结构完整，前端只读 `configured` 与 `unavailableKey`。 */
function guidanceSnapshot(
  unavailableKey: string | undefined,
  tokenHint: string | undefined,
  now: Date,
): CloudUsageSnapshot {
  const reason = CLOUD_USAGE_UNAVAILABLE.notConfigured;
  return {
    configured: false,
    unavailableKey,
    tokenHint,
    fetchedAt: now.toISOString(),
    d1: emptySection<D1Usage>(reason),
    r2: emptySection<R2Usage>(reason),
    workers: emptySection<WorkersUsage>(reason),
  };
}

/**
 * 组装一份完整快照。
 *
 * 未配置 Token / 密文解不开 / 账号 ID 缺失三种情形返回引导态快照，
 * Cloudflare 接口整体失败则抛 {@link AppError}，由端点转成错误卡文案。
 */
export async function getCloudUsageHandler(
  env: CloudUsageEnv,
): Promise<CloudUsageSnapshot> {
  const now = new Date();
  const token = await readCloudflareToken(env);
  if (token.state === "absent") {
    return guidanceSnapshot(undefined, undefined, now);
  }
  if (token.state === "unreadable") {
    return guidanceSnapshot(CLOUD_USAGE_UNAVAILABLE.tokenDecryptFailed, undefined, now);
  }

  const accountId = env.MICROFEED_CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    return guidanceSnapshot(
      CLOUD_USAGE_UNAVAILABLE.accountIdMissing,
      token.tokenHint,
      now,
    );
  }

  const scriptName = env.MICROFEED_WORKER_NAME ?? null;
  const window = queryWindow(now, scriptName);

  // 两次外网请求并行。REST 只承载一张卡，它失败时把结果记成 null，
  // 由 assembleD1 把那一张降级——GraphQL 侧的 12 张卡不受影响。
  const [payload, databaseCount] = await Promise.all([
    fetchUsageGraphQL(accountId, token.token, window),
    listD1Databases(accountId, token.token).catch(() => null),
  ]);

  // 周期边界仍用请求到达时刻（`now`）算：额度按哪个 UTC 日结算由查询时刻决定，
  // 数据晚几秒到达不该把结算日推后一天。`fetchedAt` 另取一次，是抓取完成的时刻。
  return {
    configured: true,
    tokenHint: token.tokenHint,
    fetchedAt: new Date().toISOString(),
    d1: assembleD1(dailyPeriod(now), window, payload, databaseCount),
    r2: assembleR2(monthlyPeriod(now), window, payload),
    workers: assembleWorkers(dailyPeriod(now), window, payload),
  };
}
