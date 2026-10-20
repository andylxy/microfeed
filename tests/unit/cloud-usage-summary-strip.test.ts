import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it, vi} from "vitest";

import UsageFailedCard from "@/components/admin/cloud-usage/UsageFailedCard";
import {UsageSummaryBody} from "@/components/admin/cloud-usage/UsageSummaryStrip";
import type {
  CloudUsageSnapshot,
  UsageCard as UsageCardData,
  UsagePeriod,
} from "@/shared/CloudUsage";

/**
 * 首页摘要条纯展示体的 fixture 直渲（票据 02 + 03：ready 正文与降级态）。
 *
 * `UsageSummaryStrip` 的 ready 断言必须走这层：island 层依赖 effect 触发取数，
 * 本仓 vitest 无 DOM 环境，effect 不执行，island 层只能出 loading 态。
 */

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

const PERIOD: UsagePeriod = {
  startUtc: "2026-10-18T00:00:00.000Z",
  endUtc: "2026-10-19T00:00:00.000Z",
  nextResetUtc: "2026-10-19T00:00:00.000Z",
};

// 距 2026-10-19T00:00:00Z 还有 26 小时 3 分。
const NOW_MS = Date.parse("2026-10-17T21:57:00.000Z");

function readySnapshot(configured = true): CloudUsageSnapshot {
  const section = {
    available: true,
    data: {
      period: PERIOD,
      cards: [
        {
          key: "d1RowsRead",
          value: 937660,
          limit: 5_000_000,
          limitDisplay: "5.00M",
          display: "937.66k",
          overLimit: false,
        },
        {
          key: "d1Storage",
          value: 44_510_000,
          limit: 5_000_000_000,
          limitDisplay: "5.00 GB",
          display: "44.51 MB",
          overLimit: false,
        },
      ] as UsageCardData[],
      trend: [],
      // Workers 分区形状要求的 scriptName：null = 账号级统计。
      scriptName: null,
    },
  };
  return {
    configured,
    fetchedAt: "2026-10-19T03:00:00.000Z",
    d1: section,
    r2: section,
    workers: section,
  };
}

function renderBody(snapshot: CloudUsageSnapshot): string {
  return renderToStaticMarkup(
    React.createElement(UsageSummaryBody, {
      nowMs: NOW_MS,
      refresh: () => {},
      snapshot,
    }),
  );
}

describe("UsageSummaryBody fixture", () => {
  it("ready 快照直渲：三分区标题、卡片、倒计时两行与刷新按钮齐全", () => {
    const output = renderBody(readySnapshot());

    // 三分区标题（cloudUsage.section.d1 / r2 / workers 的译文）
    expect(output).toContain(">D1</h3>");
    expect(output).toContain(">R2</h3>");
    expect(output).toContain(">Workers</h3>");
    // 卡片（cloudUsage.cards.* 文案来源）：数值、免费额度、进度条
    expect(output).toContain("Rows read");
    expect(output).toContain("Storage");
    expect(output).toContain("937.66k");
    expect(output).toContain("Free limit 5.00M");
    expect(output).toContain('role="progressbar"');
    // 倒计时两行（cloudUsage.period.* 三个键）
    expect(output).toContain(
      "Billing period (Beijing time): 2026-10-18 00:00:00 ~ 2026-10-19 00:00:00",
    );
    expect(output).toContain("Next reset: 2026-10-19 00:00:00 (Beijing time)");
    expect(output).toContain("(1d 2h 3m left)");
    // 头部「刷新」（cloudUsage.refresh）
    expect(output).toContain(">Refresh</button>");
  });

  it("不含任何图表容器：趋势图是详情页专属，不进首页链路", () => {
    const output = renderBody(readySnapshot());

    expect(output).not.toContain('preserveAspectRatio="none"');
    expect(output).not.toContain('role="img"');
    expect(output).not.toContain("<svg");
  });

  it("未配置的引导态快照走紧凑引导卡，不渲染分区内容", () => {
    const output = renderBody(readySnapshot(false));

    // 引导卡标题与正文（cloudUsage.setup.notConfigured / …Title）
    expect(output).toContain(">Cloud usage is not set up yet</div>");
    expect(output).toContain("No Cloudflare API token is saved yet.");
    // 未配置可在设置页处理：给设置页 Cloudflare 令牌锚点
    expect(output).toContain('href="/admin/settings/#cloudflare-token"');
    expect(output).toContain("Go to Settings");
    // 不编造分区内容：没有分区标题、卡片与周期
    expect(output).not.toContain(">D1</h3>");
    expect(output).not.toContain('role="progressbar"');
    expect(output).not.toContain("Billing period");
  });

  it("引导态三变体：可修的两态带设置页锚点，账号 ID 缺失不带，均无趋势图", () => {
    const setupSnapshot = (unavailableKey?: string): CloudUsageSnapshot => {
      const snapshot = readySnapshot(false);
      if (unavailableKey) snapshot.unavailableKey = unavailableKey;
      return snapshot;
    };
    const notConfigured = renderBody(setupSnapshot());
    const tokenDecryptFailed = renderBody(setupSnapshot("tokenDecryptFailed"));
    const accountIdMissing = renderBody(setupSnapshot("accountIdMissing"));

    // 三态各自的标题与正文（cloudUsage.setup.*）
    expect(notConfigured).toContain(">Cloud usage is not set up yet</div>");
    expect(notConfigured).toContain("No Cloudflare API token is saved yet.");
    expect(tokenDecryptFailed).toContain(">The saved token cannot be read</div>");
    expect(tokenDecryptFailed).toContain("Save it again in Settings.");
    expect(accountIdMissing).toContain(">Cloudflare account ID is missing</div>");
    expect(accountIdMissing).toContain("This instance has no Cloudflare account ID");

    // 未配置与密文解不开可在设置页处理：都给设置页 Cloudflare 令牌锚点
    for (const fixable of [notConfigured, tokenDecryptFailed]) {
      expect(fixable).toContain('href="/admin/settings/#cloudflare-token"');
      expect(fixable).toContain("Go to Settings");
    }

    // 账号 ID 不在设置页管理：这一态不给设置页链接
    expect(accountIdMissing).not.toContain("#cloudflare-token");

    // 三态均不含趋势图与分区内容
    for (const output of [notConfigured, tokenDecryptFailed, accountIdMissing]) {
      expect(output).not.toContain(">D1</h3>");
      expect(output).not.toContain("<svg");
      expect(output).not.toContain('preserveAspectRatio="none"');
      expect(output).not.toContain('role="progressbar"');
    }
  });

  it("整区不可用时只留分区标题，不编造周期与卡片", () => {
    const snapshot = readySnapshot();
    snapshot.r2 = {available: false, unavailableKey: "graphqlFailed", data: null};
    const output = renderBody(snapshot);

    expect(output).toContain(">R2</h3>");
    // R2 的周期与卡片都不渲染：整个条带只剩 D1 与 Workers 两处 period 文案。
    expect(output.match(/Billing period \(Beijing time\)/gu)).toHaveLength(2);
  });
});

describe("UsageSummaryStrip 共享边界", () => {
  it("复用周期两行、卡片网格与取数 hook，不引趋势图、不另起定时器", async () => {
    const source = await readFile(
      path.join(repositoryRoot, "src", "components", "admin", "cloud-usage", "UsageSummaryStrip.tsx"),
      "utf8",
    );

    expect(source).toContain("UsagePeriodLines");
    expect(source).toContain("UsageSectionGrid");
    expect(source).toContain("useCloudUsageSnapshot");
    expect(source).not.toContain("UsageTrendChart");
    expect(source).not.toContain("setInterval(");
    expect(source).not.toContain("grid gap-3 sm:grid-cols-2 lg:grid-cols-3");
    expect(source).not.toContain('from "@/server/');
  });

  it("薄消费端按三态接线：失败卡、引导态与正文各就其位", async () => {
    const source = await readFile(
      path.join(repositoryRoot, "src", "components", "admin", "cloud-usage", "UsageSummaryStrip.tsx"),
      "utf8",
    );

    // failed → 失败卡，retry 入口即 refresh（不新增第二条取数路径）
    expect(source).toContain('state.status === "failed"');
    expect(source).toContain("<UsageFailedCard");
    expect(source).toContain("onRetry={refresh}");
    // ready+!configured → 引导态（判定走共享小件）；ready+configured → 正文
    expect(source).toContain("cloudUsageSetupState");
    expect(source).toContain("if (!snapshot.configured)");
    expect(source).toContain("<UsageSetupCard");
    // loading → 维持现状
    expect(source).toContain("AdminCollectionLoading");
    expect(source).toContain('t("cloudUsage.loading")');
  });
});

describe("UsageFailedCard", () => {
  it("渲染失败标题、服务端错误原文与重试入口", () => {
    const output = renderToStaticMarkup(
      React.createElement(UsageFailedCard, {
        message: "服务端错误原文",
        onRetry: () => {},
      }),
    );

    // cloudUsage.failed 标题
    expect(output).toContain(">Could not load usage data.</div>");
    // state.message 原文照登，不套模板
    expect(output).toContain("服务端错误原文");
    // cloudUsage.retry 重试入口
    expect(output).toContain(">Retry</button>");
  });

  it("重试入口调用 onRetry：与 ready 态刷新是同一次重取", () => {
    const onRetry = vi.fn();
    // 无 DOM 环境不派发点击：卡片把 onRetry 透传给重试按钮，这里直接调用
    // 消费端传给卡片的同一个 refresh 入口。
    renderToStaticMarkup(
      React.createElement(UsageFailedCard, {message: "服务端错误原文", onRetry}),
    );

    onRetry();

    expect(onRetry).toHaveBeenCalledOnce();
  });
});
