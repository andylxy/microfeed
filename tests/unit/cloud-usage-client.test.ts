import {afterEach, describe, expect, it} from "vitest";

import {
  fetchUsageGraphQL,
  type UsageQueryWindow,
} from "@/server/cloud-usage/CloudflareClient";
import {AppError} from "@/shared/errors";

/**
 * 并行 dataset 客户端的行为守卫。
 *
 * 这层没有现成测试：它纯靠外网 fetch，过去不好测。并行化之后「部分失败
 * 只降级对应分区、全失败才抛」的语义是看板可用性的关键，用 fetch 桩把它
 * 固定下来。
 */

const window: UsageQueryWindow = {
  dayFromDate: "2026-10-13",
  dayToDate: "2026-10-19",
  monthFromDate: "2026-10-01",
  dayFromIso: "2026-10-13T00:00:00.000Z",
  monthFromIso: "2026-10-01T00:00:00.000Z",
  nowIso: "2026-10-19T03:00:00.000Z",
  scriptName: null,
};

/** 每条查询按 dataset 名称路由到对应的假响应。 */
type Responder = (dataset: string) => {status: number; body: unknown} | never;

const DATASET_MARKERS = [
  "d1AnalyticsAdaptiveGroups",
  "d1StorageAdaptiveGroups",
  "r2OperationsAdaptiveGroups",
  "r2StorageAdaptiveGroups",
  "workersInvocationsAdaptive",
];

function installFetch(responder: Responder): void {
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {query: string};
    const dataset = DATASET_MARKERS.find((marker) => body.query.includes(marker));
    if (!dataset) throw new Error("unrecognized query in test stub");
    const reply = responder(dataset);
    return new Response(JSON.stringify(reply.body), {status: reply.status});
  }) as typeof fetch;
}

function okAccount(accounts: Record<string, unknown>): {status: number; body: unknown} {
  return {status: 200, body: {data: {viewer: {accounts: [accounts]}}}};
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const realFetch = globalThis.fetch;

describe("fetchUsageGraphQL parallel datasets", () => {
  it("maps all five datasets when every request succeeds", async () => {
    installFetch(() =>
      okAccount({
        d1AnalyticsAdaptiveGroups: [
          {sum: {rowsRead: 10, rowsWritten: 2}, dimensions: {date: "2026-10-19", databaseId: "db1"}},
        ],
        d1StorageAdaptiveGroups: [
          {max: {databaseSizeBytes: 4096}, dimensions: {date: "2026-10-19", databaseId: "db1"}},
        ],
        r2OperationsAdaptiveGroups: [
          {sum: {requests: 7}, dimensions: {actionType: "PutObject", datetime: "2026-10-19T00:00:00Z"}},
        ],
        r2StorageAdaptiveGroups: [
          {max: {payloadSize: 100, metadataSize: 4}, dimensions: {bucketName: "b1", datetime: "2026-10-19T00:00:00Z"}},
        ],
        workersInvocationsAdaptive: [
          {sum: {requests: 5, errors: 1, subrequests: 3}, quantiles: {cpuTimeP99: 12.5}, dimensions: {datetime: "2026-10-19T00:00:00Z"}},
        ],
      }),
    );

    const payload = await fetchUsageGraphQL("acct", "tok", window);
    expect(payload.d1Analytics).toEqual([
      {date: "2026-10-19", databaseId: "db1", rowsRead: 10, rowsWritten: 2},
    ]);
    expect(payload.d1Storage).toEqual([
      {date: "2026-10-19", databaseId: "db1", databaseSizeBytes: 4096},
    ]);
    expect(payload.r2Operations).toEqual([
      {actionType: "PutObject", datetime: "2026-10-19T00:00:00Z", requests: 7},
    ]);
    expect(payload.r2Storage).toEqual([
      {bucketName: "b1", datetime: "2026-10-19T00:00:00Z", payloadSize: 100, metadataSize: 4},
    ]);
    expect(payload.workersInvocations).toEqual([
      {datetime: "2026-10-19T00:00:00Z", requests: 5, errors: 1, subrequests: 3, cpuTimeP99: 12.5},
    ]);
  });

  it("keeps successful datasets and leaves a failed one undefined", async () => {
    installFetch((dataset) =>
      dataset === "r2OperationsAdaptiveGroups"
        ? {status: 200, body: {errors: [{message: "upstream error"}], data: null}}
        : okAccount({
            d1AnalyticsAdaptiveGroups: [],
            d1StorageAdaptiveGroups: [],
            r2StorageAdaptiveGroups: [],
            workersInvocationsAdaptive: [],
          }),
    );

    const payload = await fetchUsageGraphQL("acct", "tok", window);
    expect(payload.r2Operations).toBeUndefined();
    expect(payload.d1Analytics).toEqual([]);
    expect(payload.d1Storage).toEqual([]);
    expect(payload.r2Storage).toEqual([]);
    expect(payload.workersInvocations).toEqual([]);
  });

  it("throws the first failure reason when every dataset fails", async () => {
    installFetch(() => ({status: 500, body: {errors: [{message: "boom"}]}}));

    const error = await fetchUsageGraphQL("acct", "tok", window).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
  });

  it("maps a timeout rejection to the requestTimeout AppError", async () => {
    globalThis.fetch = (async () => {
      throw new DOMException("signal timed out", "TimeoutError");
    }) as typeof fetch;

    const error = await fetchUsageGraphQL("acct", "tok", window).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).i18nKey).toBe("errors.cloudUsage.requestTimeout");
  });
});
