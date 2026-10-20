import {readFile, readdir} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {afterEach, describe, expect, it, vi} from "vitest";

import {
  CloudUsageSnapshotLoader,
  cloudUsageStateFromResponse,
  COUNTDOWN_TICK_MS,
  type SnapshotResponse,
} from "@/components/admin/cloud-usage/CloudUsageSnapshotLoader";
import UsagePeriodLines, {countdownParts} from "@/components/admin/cloud-usage/UsagePeriodLines";
import UsageSectionGrid from "@/components/admin/cloud-usage/UsageSectionGrid";
import {degradedTone} from "@/components/admin/cloud-usage/usageDegradedTone";
import {cloudUsageSetupState} from "@/components/admin/cloud-usage/cloudUsageSetupState";
import type {
  CloudUsageSnapshot,
  UsageCard as UsageCardData,
  UsagePeriod,
} from "@/shared/CloudUsage";

/**
 * Cloud-usage 三共享件的行为守卫：周期两行、取数协调器（tick 与取数解耦）、
 * 分区卡片网格。组件一律 renderToStaticMarkup（本仓无 DOM 环境，effect 不执行），
 * 取数协调器是普通类，用假定时器与计数器直测。
 */

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const cloudUsageDirectory = path.join(
  repositoryRoot,
  "src",
  "components",
  "admin",
  "cloud-usage",
);

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {withFileTypes: true});
  return (await Promise.all(entries.map(async (entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory()
      ? filesUnder(filename)
      : /\.(?:astro|ts|tsx)$/u.test(entry.name) && !entry.name.endsWith(".d.ts")
        ? [filename]
        : [];
  }))).flat();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return {promise, resolve};
}

const PERIOD: UsagePeriod = {
  startUtc: "2026-10-18T00:00:00.000Z",
  endUtc: "2026-10-19T00:00:00.000Z",
  nextResetUtc: "2026-10-19T00:00:00.000Z",
};

function snapshotFixture(configured = true): CloudUsageSnapshot {
  const section = {available: true, data: null};
  return {
    configured,
    fetchedAt: "2026-10-19T03:00:00.000Z",
    d1: section,
    r2: section,
    workers: section,
  };
}

describe("UsagePeriodLines", () => {
  it("渲染计费周期、下次重置与倒计时，文案走 cloudUsage.period.* 键", () => {
    // 距 2026-10-19T00:00:00Z 还有 26 小时 3 分。
    const nowMs = Date.parse("2026-10-17T21:57:00.000Z");
    const output = renderToStaticMarkup(
      React.createElement(UsagePeriodLines, {period: PERIOD, nowMs}),
    );

    expect(output).toContain(
      "Billing period (Beijing time): 2026-10-18 00:00:00 ~ 2026-10-19 00:00:00",
    );
    expect(output).toContain("Next reset: 2026-10-19 00:00:00 (Beijing time)");
    expect(output).toContain("(1d 2h 3m left)");
  });

  it("倒计时在重置时刻之后归零", () => {
    expect(
      countdownParts(PERIOD.nextResetUtc, Date.parse("2026-10-19T00:01:00.000Z")),
    ).toEqual({days: 0, hours: 0, minutes: 0});
  });
});

describe("cloudUsageStateFromResponse", () => {
  it("ok:true 且带 data → ready", () => {
    const snapshot = snapshotFixture();
    expect(cloudUsageStateFromResponse({ok: true, data: snapshot}, "兜底文案")).toEqual({
      status: "ready",
      snapshot,
    });
  });

  it("未配置的引导态快照仍算 ready，由 configured 区分", () => {
    const state = cloudUsageStateFromResponse(
      {ok: true, data: snapshotFixture(false)},
      "兜底文案",
    );
    expect(state.status).toBe("ready");
    expect(state.status === "ready" && state.snapshot.configured).toBe(false);
  });

  it("ok:false → failed，message 取服务端 error 文案", () => {
    expect(
      cloudUsageStateFromResponse({ok: false, error: "服务端文案"}, "兜底文案"),
    ).toEqual({status: "failed", message: "服务端文案"});
  });

  it("缺 data 或缺 error → failed 用兜底文案", () => {
    expect(cloudUsageStateFromResponse({ok: true}, "兜底文案")).toEqual({
      status: "failed",
      message: "兜底文案",
    });
    expect(cloudUsageStateFromResponse({ok: false}, "兜底文案")).toEqual({
      status: "failed",
      message: "兜底文案",
    });
  });
});

describe("cloudUsageSetupState", () => {
  it("无 unavailableKey → notConfigured，可在设置页处理", () => {
    expect(cloudUsageSetupState(undefined)).toEqual({
      reason: "notConfigured",
      fixableInSettings: true,
    });
  });

  it("tokenDecryptFailed → fixableInSettings=true（重新保存令牌即可）", () => {
    expect(cloudUsageSetupState("tokenDecryptFailed")).toEqual({
      reason: "tokenDecryptFailed",
      fixableInSettings: true,
    });
  });

  it("accountIdMissing → fixableInSettings=false（账号 ID 不归设置页管）", () => {
    expect(cloudUsageSetupState("accountIdMissing")).toEqual({
      reason: "accountIdMissing",
      fixableInSettings: false,
    });
  });

  it("未知键原样透过，按可在设置页处理", () => {
    expect(cloudUsageSetupState("someFutureReason")).toEqual({
      reason: "someFutureReason",
      fixableInSettings: true,
    });
  });
});

describe("CloudUsageSnapshotLoader", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("挂载取一次；连续推进时钟只走 nowMs、不发生第二次请求", async () => {
    vi.useFakeTimers();
    const first = deferred<SnapshotResponse>();
    const fetchSnapshot = vi.fn(() => first.promise);
    const loader = new CloudUsageSnapshotLoader({
      fetchSnapshot,
      failedFallback: () => "兜底文案",
    });

    const stop = loader.start();
    expect(fetchSnapshot).toHaveBeenCalledOnce();
    expect(loader.state).toEqual({status: "loading"});

    first.resolve({ok: true, data: snapshotFixture()});
    await first.promise;
    expect(loader.state).toEqual({status: "ready", snapshot: snapshotFixture()});
    const nowAfterLoad = loader.nowMs;

    vi.advanceTimersByTime(COUNTDOWN_TICK_MS * 5);
    expect(fetchSnapshot).toHaveBeenCalledOnce();
    expect(loader.nowMs).toBe(nowAfterLoad + COUNTDOWN_TICK_MS * 5);

    stop();
    vi.advanceTimersByTime(COUNTDOWN_TICK_MS * 5);
    expect(fetchSnapshot).toHaveBeenCalledOnce();
    expect(loader.nowMs).toBe(nowAfterLoad + COUNTDOWN_TICK_MS * 5);
  });

  it("refresh() 重取：先回 loading，失败保留 error 文案，再取成功回 ready", async () => {
    const first = deferred<SnapshotResponse>();
    const fetchSnapshot = vi.fn(() => first.promise);
    const loader = new CloudUsageSnapshotLoader({
      fetchSnapshot,
      failedFallback: () => "兜底文案",
    });

    void loader.refresh();
    expect(fetchSnapshot).toHaveBeenCalledOnce();
    expect(loader.state).toEqual({status: "loading"});

    first.resolve({ok: false, error: "服务端文案"});
    await first.promise;
    expect(loader.state).toEqual({status: "failed", message: "服务端文案"});

    const second = deferred<SnapshotResponse>();
    fetchSnapshot.mockImplementation(() => second.promise);
    void loader.refresh();
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(loader.state).toEqual({status: "loading"});

    second.resolve({ok: true, data: snapshotFixture()});
    await second.promise;
    expect(loader.state).toEqual({status: "ready", snapshot: snapshotFixture()});
  });

  it("取数抛错 → failed，message 沿用 errorMessage 取到的服务端文案", async () => {
    const loader = new CloudUsageSnapshotLoader({
      fetchSnapshot: async () => {
        throw {response: {data: {error: "服务端文案"}}};
      },
      failedFallback: () => "兜底文案",
    });

    await loader.refresh();
    expect(loader.state).toEqual({status: "failed", message: "服务端文案"});
  });

  it("取数抛错且服务端没给文案 → failed 用兜底文案", async () => {
    const loader = new CloudUsageSnapshotLoader({
      fetchSnapshot: async () => {
        throw new Error("network down");
      },
      failedFallback: () => "兜底文案",
    });

    await loader.refresh();
    expect(loader.state).toEqual({status: "failed", message: "兜底文案"});
  });

  it("订阅者在状态变化时收到通知", async () => {
    const pending = deferred<SnapshotResponse>();
    const loader = new CloudUsageSnapshotLoader({
      fetchSnapshot: () => pending.promise,
      failedFallback: () => "兜底文案",
    });
    const views: string[] = [];
    const unsubscribe = loader.subscribe(() => views.push(loader.state.status));

    pending.resolve({ok: true, data: snapshotFixture()});
    await loader.refresh();
    unsubscribe();
    await loader.refresh();

    expect(views).toEqual(["loading", "ready"]);
  });
});

describe("UsageSectionGrid", () => {
  it("按 cloudUsage.cards.* 键渲染卡片并保留响应式栅格", () => {
    const cards: UsageCardData[] = [
      {
        key: "d1RowsRead",
        value: 937660,
        limit: 5_000_000,
        limitDisplay: "5.00M",
        display: "937.66k",
        overLimit: false,
      },
      {
        key: "workersErrors",
        value: 3,
        limit: null,
        display: "3",
        overLimit: false,
      },
    ];
    const output = renderToStaticMarkup(
      React.createElement(UsageSectionGrid, {cards, onRetry: () => {}}),
    );

    expect(output).toContain("Rows read");
    expect(output).toContain("Errors");
    expect(output).toContain("937.66k");
    expect(output).toContain("No published free limit");
    expect(output).toContain('role="progressbar"');
    expect(output).toContain("grid gap-3 sm:grid-cols-2 lg:grid-cols-3");
  });
});

describe("degradedTone", () => {
  it("紧凑开关映射到一组尺寸/字号：compact 收小、默认按详情页", () => {
    const compact = degradedTone(true);
    const fallback = degradedTone();

    expect(compact.cardSize).toBe("sm");
    expect(compact.titleText).toBe("text-sm");
    expect(compact.bodyText).toBe("text-xs");
    expect(compact.contentGap).toBe("grid gap-2");
    expect(compact.buttonSize).toBe("sm");

    expect(fallback.cardSize).toBe("default");
    expect(fallback.titleText).toBe("text-base");
    expect(fallback.bodyText).toBe("text-sm");
    expect(fallback.contentGap).toBe("grid gap-3");
    expect(fallback.buttonSize).toBe("default");
  });

  it("undefined 与 false 同为默认尺寸", () => {
    expect(degradedTone(undefined)).toEqual(degradedTone(false));
  });
});

describe("共享边界", () => {
  it("CloudUsageApp 不再导出周期两行等共享件（首页直接引共享模块）", async () => {
    const source = await readFile(
      path.join(cloudUsageDirectory, "CloudUsageApp.tsx"),
      "utf8",
    );
    // 只允许 `export default function CloudUsageApp`，任何具名导出都算反向再导出。
    expect(source.match(/^export\s+(?!default\b)/gmu)).toBeNull();
  });

  it("全仓只有一个倒计时定时器与一份卡片网格", async () => {
    const files = await filesUnder(path.join(repositoryRoot, "src"));
    const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));

    expect(sources.join("\n").match(/setInterval\(/gu)?.length).toBe(1);
    expect(
      sources.join("\n").match(/grid gap-3 sm:grid-cols-2 lg:grid-cols-3/gu)?.length,
    ).toBe(1);
  });

  it("账号 ID 例外只有一处判定，两处消费端都走共享小件", async () => {
    const files = await filesUnder(cloudUsageDirectory);
    const judgedIn = (
      await Promise.all(
        files.map(async (file) => [
          path.basename(file),
          await readFile(file, "utf8"),
        ] as const),
      )
    )
      .filter(([, source]) => source.includes("CLOUD_USAGE_UNAVAILABLE.accountIdMissing"))
      .map(([filename]) => filename);

    // 引导态判定只存在于共享小件，详情页与首页摘要都不再内联一份
    expect(judgedIn).toEqual(["cloudUsageSetupState.ts"]);

    const [appSource, stripSource] = await Promise.all([
      readFile(path.join(cloudUsageDirectory, "CloudUsageApp.tsx"), "utf8"),
      readFile(path.join(cloudUsageDirectory, "UsageSummaryStrip.tsx"), "utf8"),
    ]);
    for (const source of [appSource, stripSource]) {
      expect(source).toContain("cloudUsageSetupState");
      expect(source).not.toContain("fixableInSettings =");
    }
  });
});
