import {type ReactNode} from "react";

import {
  AdminCollectionLoading,
} from "@/components/admin/shared/AdminCollectionState";
import {Button} from "@/components/ui/button";
import {formatAdminDateTime} from "@/client/admin-date-format";
import {useTranslation} from "@/client/i18n";
import {
  CLOUD_USAGE_UNAVAILABLE,
  type UsagePeriod,
  type UsageSection,
} from "@/shared/CloudUsage";

import UsageFailedCard from "./UsageFailedCard";
import UsagePeriodLines from "./UsagePeriodLines";
import UsageSectionGrid from "./UsageSectionGrid";
import UsageSetupCard from "./UsageSetupCard";
import UsageTrendChart, {
  TREND_ERROR_COLOR,
  TREND_PRIMARY_COLOR,
  TREND_SECONDARY_COLOR,
  trendSeries,
} from "./UsageTrendChart";
import {cloudUsageSetupState} from "./cloudUsageSetupState";
import {useCloudUsageSnapshot} from "./useCloudUsageSnapshot";

interface SectionShellProps {
  titleKey: string;
  /** 分区有数据时才有周期；整区不可用时不下发，界面也不该编一个出来。 */
  period?: UsagePeriod;
  nowMs: number;
  available: boolean;
  unavailableKey?: string;
  children: ReactNode;
}

function SectionShell({
  titleKey,
  period,
  nowMs,
  available,
  unavailableKey,
  children,
}: SectionShellProps) {
  const {t} = useTranslation();
  return (
    <section className="grid gap-3">
      <div className="grid gap-1">
        <h2 className="text-base font-semibold">{t(titleKey)}</h2>
        {period && <UsagePeriodLines nowMs={nowMs} period={period} />}
      </div>
      {!available && (
        <p
          className="rounded-[14px] border border-destructive/40 bg-destructive/5 p-3 text-sm"
          role="alert"
        >
          {t("cloudUsage.degraded", {
            reason: t(`cloudUsage.unavailable.${unavailableKey ?? CLOUD_USAGE_UNAVAILABLE.graphqlFailed}`),
          })}
        </p>
      )}
      {children}
    </section>
  );
}

/**
 * Cloudflare 使用情况仪表盘（`/admin/cloud-usage`，migration 0123）。
 *
 * 打开时请求一次快照，四种界面：加载、整体失败（可重试）、引导态（未配置 /
 * 解不开 / 账号 ID 缺失）、正常三分区。分区级失败只在该分区顶部显示降级条。
 *
 * 取数、周期两行、卡片网格、引导态卡片与失败卡分别是 cloud-usage 目录下的
 * 共享件（hook / UsagePeriodLines / UsageSectionGrid / UsageSetupCard /
 * UsageFailedCard），首页摘要复用同一套实现；引导态判定走共享纯函数
 * `cloudUsageSetupState`，分区级降级条（`cloudUsage.degraded`）是本页专属。
 *
 * 所有时刻走 `formatAdminDateTime`（AGENTS.md「管理后台国际化」禁止
 * `Intl.DateTimeFormat` / `toLocaleString`）；服务端下发的都是带 `Z` 的 UTC 串，
 * 本组件不做任何手工时区加减。
 */
export default function CloudUsageApp() {
  const {t} = useTranslation();
  const {state, nowMs, refresh} = useCloudUsageSnapshot();

  if (state.status === "loading") {
    return <AdminCollectionLoading label={t("cloudUsage.loading")} />;
  }

  if (state.status === "failed") {
    return <UsageFailedCard message={state.message} onRetry={refresh} />;
  }

  const {snapshot} = state;
  if (!snapshot.configured) {
    const setup = cloudUsageSetupState(snapshot.unavailableKey);
    return (
      <UsageSetupCard
        fixableInSettings={setup.fixableInSettings}
        reason={setup.reason}
      />
    );
  }

  const d1Trend = trendSeries(
    snapshot.d1.data?.trend,
    {
      labelKey: "cloudUsage.trend.rowsRead",
      pick: (point) => point.rowsRead,
      color: TREND_PRIMARY_COLOR,
    },
    {
      labelKey: "cloudUsage.trend.rowsWritten",
      pick: (point) => point.rowsWritten,
      color: TREND_SECONDARY_COLOR,
    },
  );
  const r2Trend = trendSeries(
    snapshot.r2.data?.trend,
    {
      labelKey: "cloudUsage.trend.classA",
      pick: (point) => point.classA,
      color: TREND_PRIMARY_COLOR,
    },
    {
      labelKey: "cloudUsage.trend.classB",
      pick: (point) => point.classB,
      color: TREND_SECONDARY_COLOR,
    },
  );
  const workersTrend = trendSeries(
    snapshot.workers.data?.trend,
    {
      labelKey: "cloudUsage.trend.requests",
      pick: (point) => point.requests,
      color: TREND_PRIMARY_COLOR,
    },
    {
      labelKey: "cloudUsage.trend.errors",
      pick: (point) => point.errors,
      color: TREND_ERROR_COLOR,
    },
  );

  const trendDates = (section: UsageSection<{trend: {date: string}[]}>) =>
    section.data?.trend.map((point) => point.date) ?? [];

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {t("cloudUsage.updatedAt", {time: formatAdminDateTime(snapshot.fetchedAt)})}
        </p>
        <Button onClick={refresh} size="sm" type="button" variant="outline">
          {t("cloudUsage.refresh")}
        </Button>
      </div>

      <SectionShell
        available={snapshot.d1.available}
        nowMs={nowMs}
        period={snapshot.d1.data?.period}
        titleKey="cloudUsage.section.d1"
        unavailableKey={snapshot.d1.unavailableKey}
      >
        {snapshot.d1.data && (
          <>
            <UsageSectionGrid cards={snapshot.d1.data.cards} onRetry={refresh} />
            <UsageTrendChart dates={trendDates(snapshot.d1)} series={d1Trend} />
          </>
        )}
      </SectionShell>

      <SectionShell
        available={snapshot.r2.available}
        nowMs={nowMs}
        period={snapshot.r2.data?.period}
        titleKey="cloudUsage.section.r2"
        unavailableKey={snapshot.r2.unavailableKey}
      >
        {snapshot.r2.data && (
          <>
            <UsageSectionGrid cards={snapshot.r2.data.cards} onRetry={refresh} />
            <UsageTrendChart dates={trendDates(snapshot.r2)} series={r2Trend} />
            <p className="text-xs text-muted-foreground">
              {t("cloudUsage.note.r2Egress")}
            </p>
          </>
        )}
      </SectionShell>

      <SectionShell
        available={snapshot.workers.available}
        nowMs={nowMs}
        period={snapshot.workers.data?.period}
        titleKey="cloudUsage.section.workers"
        unavailableKey={snapshot.workers.unavailableKey}
      >
        {snapshot.workers.data && (
          <>
            <UsageSectionGrid cards={snapshot.workers.data.cards} onRetry={refresh} />
            <UsageTrendChart dates={trendDates(snapshot.workers)} series={workersTrend} />
          </>
        )}
      </SectionShell>
    </div>
  );
}
