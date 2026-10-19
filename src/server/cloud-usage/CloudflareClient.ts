/**
 * Cloudflare 官方只读接口的客户端。
 *
 * 5 个 dataset（D1 读写、D1 存储、R2 操作、R2 存储、Workers 调用）各自用
 * 一个独立的小查询并行取回，另有一次 REST 请求取 D1 库数。Token 由调用方
 * 传入，本模块不感知它存在哪里、怎么加密。
 *
 * 小查询并行是刻意的：到 Cloudflare 的直连链路波动很大，合并大查询实测能
 * 慢到十几秒、稳定撞穿超时；单个小查询即使慢窗口也在 2~4 秒内回来。
 *
 * 部分失败的处理：某个 dataset 的请求失败或返回缺字段时，它留 `undefined`，
 * 由上层把对应分区标成不可用；五个全部失败（账号 ID 错误、断网等）才抛
 * {@link AppError}，上层显示整页错误卡。
 *
 * 时区：Cloudflare 的 `date_geq` / `datetime_geq` 语义就是 UTC，接口不接受时区
 * 参数，本模块只负责把这些边界原样下发。
 */
import {AppError} from "@/shared/errors";

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

/** 8 秒。慢于这个时间的响应对运维看板没有意义，早点失败好过一直转圈。 */
const REQUEST_TIMEOUT_MS = 8000;

/** 每个 dataset 的上限。7 日 / 当月窗口在维度分组后远小于这个数。 */
const DATASET_LIMIT = 10_000;

/** 查询窗口。所有边界由调用方按 UTC 算好，本模块只做拼装。 */
export interface UsageQueryWindow {
  /** 近 7 日窗口起点（UTC 日期 `YYYY-MM-DD`） */
  dayFromDate: string;
  /** 今天（UTC 日期） */
  dayToDate: string;
  /** 当月 1 日（UTC 日期） */
  monthFromDate: string;
  /** 近 7 日窗口起点时刻（UTC ISO） */
  dayFromIso: string;
  /** 当月 1 日 00:00（UTC ISO） */
  monthFromIso: string;
  /** 当前时刻（UTC ISO） */
  nowIso: string;
  /** Worker 脚本名；null = 不限脚本，统计为账号级 */
  scriptName: string | null;
}

export interface D1AnalyticsRow {
  date: string;
  databaseId: string;
  rowsRead: number;
  rowsWritten: number;
}

export interface D1StorageRow {
  date: string;
  databaseId: string;
  databaseSizeBytes: number;
}

export interface R2OperationsRow {
  actionType: string;
  datetime: string;
  requests: number;
}

export interface R2StorageRow {
  bucketName: string;
  datetime: string;
  payloadSize: number;
  metadataSize: number;
}

export interface WorkersInvocationsRow {
  datetime: string;
  requests: number;
  errors: number;
  subrequests: number;
  cpuTimeP99: number;
}

/**
 * 合并查询的结果。某个 dataset 缺失时该字段为 `undefined`——这既可能是
 * GraphQL 部分失败，也可能是该窗口确实没有数据；上层按「该分区不可用」处理
 * 更保守，运维看到「暂不可用」比看到 0 更不容易误判。
 */
export interface UsageGraphQLPayload {
  d1Analytics?: D1AnalyticsRow[];
  d1Storage?: D1StorageRow[];
  r2Operations?: R2OperationsRow[];
  r2Storage?: R2StorageRow[];
  workersInvocations?: WorkersInvocationsRow[];
}

interface GraphQLErrorEntry {
  message?: string;
}

interface GraphQLResponse {
  data?: {
    viewer?: {
      accounts?: GraphQLAccountNode[];
    };
  } | null;
  errors?: GraphQLErrorEntry[];
}

interface GraphQLAccountNode {
  d1AnalyticsAdaptiveGroups?: Array<{
    sum?: {rowsRead?: number | null; rowsWritten?: number | null} | null;
    dimensions?: {date?: string; databaseId?: string} | null;
  }>;
  d1StorageAdaptiveGroups?: Array<{
    max?: {databaseSizeBytes?: number | null} | null;
    dimensions?: {date?: string; databaseId?: string} | null;
  }>;
  r2OperationsAdaptiveGroups?: Array<{
    sum?: {requests?: number | null} | null;
    dimensions?: {actionType?: string; datetime?: string} | null;
  }>;
  r2StorageAdaptiveGroups?: Array<{
    max?: {
      payloadSize?: number | null;
      metadataSize?: number | null;
    } | null;
    dimensions?: {bucketName?: string; datetime?: string} | null;
  }>;
  workersInvocationsAdaptive?: Array<{
    sum?: {requests?: number | null; errors?: number | null; subrequests?: number | null} | null;
    quantiles?: {cpuTimeP99?: number | null} | null;
    dimensions?: {datetime?: string} | null;
  }>;
}

interface D1ListResponse {
  success?: boolean;
  errors?: GraphQLErrorEntry[];
  result?: unknown[];
  result_info?: {total_count?: number};
}

/**
 * 把 fetch 的超时与网络失败归成两种可区分的错误。
 *
 * 响应体的读取也必须在守护范围内：超时信号触发时 workerd 会连进行中的
 * body 传输一起中止，body 读取若留在守护之外，慢链路下就会漏出未映射的
 * 原始 abort 错误，端点只能给浏览器一个裸 500。
 */
async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  let text: string;
  let status = 0;
  try {
    const response = await fetch(url, {...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)});
    status = response.status;
    text = await response.text();
  } catch (error) {
    if ((error as {name?: string})?.name === "TimeoutError") {
      throw new AppError("errors.cloudUsage.requestTimeout", 504);
    }
    throw new AppError("errors.cloudUsage.requestFailed", 502, {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (status < 200 || status >= 300) {
    const message = (payload as GraphQLResponse | null)?.errors?.[0]?.message
      ?? `HTTP ${status}`;
    throw new AppError("errors.cloudUsage.requestFailed", 502, {message});
  }
  return payload as T;
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

/**
 * 单 dataset 查询的公共外壳：查询名与字段选择由调用方给，账号过滤与
 * 变量声明共用这一份。
 */
function accountQuery(selection: string): string {
  return `query Usage($accountTag: String!) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      ${selection}
    }
  }
}`;
}

function d1AnalyticsQuery(window: UsageQueryWindow): string {
  return accountQuery(`d1AnalyticsAdaptiveGroups(
        filter: {date_geq: ${quoted(window.dayFromDate)}, date_leq: ${quoted(window.dayToDate)}}
        limit: ${DATASET_LIMIT}
      ) {
        sum { rowsRead rowsWritten }
        dimensions { date databaseId }
      }`);
}

function d1StorageQuery(window: UsageQueryWindow): string {
  return accountQuery(`d1StorageAdaptiveGroups(
        filter: {date_geq: ${quoted(window.monthFromDate)}, date_leq: ${quoted(window.dayToDate)}}
        limit: ${DATASET_LIMIT}
      ) {
        max { databaseSizeBytes }
        dimensions { date databaseId }
      }`);
}

function r2OperationsQuery(window: UsageQueryWindow): string {
  return accountQuery(`r2OperationsAdaptiveGroups(
        filter: {datetime_geq: ${quoted(window.monthFromIso)}, datetime_leq: ${quoted(window.nowIso)}}
        limit: ${DATASET_LIMIT}
      ) {
        sum { requests }
        dimensions { actionType datetime }
      }`);
}

function r2StorageQuery(window: UsageQueryWindow): string {
  return accountQuery(`r2StorageAdaptiveGroups(
        filter: {datetime_geq: ${quoted(window.monthFromIso)}, datetime_leq: ${quoted(window.nowIso)}}
        limit: ${DATASET_LIMIT}
      ) {
        max { payloadSize metadataSize }
        dimensions { bucketName datetime }
      }`);
}

function workersInvocationsQuery(window: UsageQueryWindow): string {
  const scriptFilter = window.scriptName
    ? `scriptName: ${quoted(window.scriptName)}, `
    : "";
  return accountQuery(`workersInvocationsAdaptive(
        filter: {${scriptFilter}datetime_geq: ${quoted(window.dayFromIso)}, datetime_leq: ${quoted(window.nowIso)}}
        limit: ${DATASET_LIMIT}
      ) {
        sum { requests errors subrequests }
        quantiles { cpuTimeP99 }
        dimensions { datetime }
      }`);
}

function numberOrZero(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 取 `datetime` 的前 10 个字符作为 UTC 日期，与 D1 的 `date` 维度取同一个日期口径。 */
function utcDateOf(datetime: string): string {
  return datetime.slice(0, 10);
}

/**
 * 单个 dataset 的独立请求。返回 `undefined` 表示这个 dataset 这次没拿到
 * （GraphQL 对它返回了错误或字段缺失），由上层按「分区不可用」降级。
 * 连账号节点都没有时按失败抛出：账号 ID 错误、Token 无权限这类故障会让
 * 五个 dataset 一起走到这里，上层取第一个原因抛出。
 */
async function fetchDataset<T>(
  accountId: string,
  token: string,
  query: string,
  pick: (account: GraphQLAccountNode) => T[] | undefined,
): Promise<T[] | undefined> {
  const payload = await requestJson<GraphQLResponse>(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({query, variables: {accountTag: accountId}}),
  });
  const account = payload.data?.viewer?.accounts?.[0];
  if (!account) {
    const message = payload.errors?.[0]?.message ?? "no account data returned";
    throw new AppError("errors.cloudUsage.requestFailed", 502, {message});
  }
  return pick(account);
}

/**
 * 并行取 5 个 dataset。
 *
 * 五个全部失败＝账号或网络层面的整体故障，抛第一个原因给端点转错误卡；
 * 有成功的就返回部分结果，失败的 dataset 留 `undefined` 由分区降级。
 */
export async function fetchUsageGraphQL(
  accountId: string,
  token: string,
  window: UsageQueryWindow,
): Promise<UsageGraphQLPayload> {
  const settled = await Promise.allSettled([
    fetchDataset(accountId, token, d1AnalyticsQuery(window), (account) =>
      account.d1AnalyticsAdaptiveGroups?.map((row) => ({
        date: row.dimensions?.date ?? "",
        databaseId: row.dimensions?.databaseId ?? "",
        rowsRead: numberOrZero(row.sum?.rowsRead),
        rowsWritten: numberOrZero(row.sum?.rowsWritten),
      })),
    ),
    fetchDataset(accountId, token, d1StorageQuery(window), (account) =>
      account.d1StorageAdaptiveGroups?.map((row) => ({
        date: row.dimensions?.date ?? "",
        databaseId: row.dimensions?.databaseId ?? "",
        databaseSizeBytes: numberOrZero(row.max?.databaseSizeBytes),
      })),
    ),
    fetchDataset(accountId, token, r2OperationsQuery(window), (account) =>
      account.r2OperationsAdaptiveGroups?.map((row) => ({
        actionType: row.dimensions?.actionType ?? "",
        datetime: row.dimensions?.datetime ?? "",
        requests: numberOrZero(row.sum?.requests),
      })),
    ),
    fetchDataset(accountId, token, r2StorageQuery(window), (account) =>
      account.r2StorageAdaptiveGroups?.map((row) => ({
        bucketName: row.dimensions?.bucketName ?? "",
        datetime: row.dimensions?.datetime ?? "",
        payloadSize: numberOrZero(row.max?.payloadSize),
        metadataSize: numberOrZero(row.max?.metadataSize),
      })),
    ),
    fetchDataset(accountId, token, workersInvocationsQuery(window), (account) =>
      account.workersInvocationsAdaptive?.map((row) => ({
        datetime: row.dimensions?.datetime ?? "",
        requests: numberOrZero(row.sum?.requests),
        errors: numberOrZero(row.sum?.errors),
        subrequests: numberOrZero(row.sum?.subrequests),
        cpuTimeP99: numberOrZero(row.quantiles?.cpuTimeP99),
      })),
    ),
  ]);

  const failures = settled.filter(
    (item): item is PromiseRejectedResult => item.status === "rejected",
  );
  if (failures.length === settled.length) {
    throw failures[0]!.reason;
  }

  return {
    d1Analytics: fulfilledRows(settled[0]),
    d1Storage: fulfilledRows(settled[1]),
    r2Operations: fulfilledRows(settled[2]),
    r2Storage: fulfilledRows(settled[3]),
    workersInvocations: fulfilledRows(settled[4]),
  };
}

/** `Promise.allSettled` 的单槽取值：成功给值，失败或缺位给 `undefined`。 */
function fulfilledRows<T>(
  item: PromiseSettledResult<T[] | undefined> | undefined,
): T[] | undefined {
  return item?.status === "fulfilled" ? item.value : undefined;
}

/**
 * 列库取总数。`result_info.total_count` 缺失时回退 `result.length`——账号库数
 * 远小于一页上限，两种口径结果相同。
 */
export async function listD1Databases(
  accountId: string,
  token: string,
): Promise<number> {
  const payload = await requestJson<D1ListResponse>(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database`,
    {
      method: "GET",
      headers: {authorization: `Bearer ${token}`},
    },
  );
  if (payload.success === false) {
    const message = payload.errors?.[0]?.message ?? "D1 list failed";
    throw new AppError("errors.cloudUsage.requestFailed", 502, {message});
  }
  const total = payload.result_info?.total_count;
  return typeof total === "number" ? total : (payload.result?.length ?? 0);
}

/** 供上层按日聚合时复用：`datetime` 的前 10 个字符即 UTC 日期。 */
export {utcDateOf};
