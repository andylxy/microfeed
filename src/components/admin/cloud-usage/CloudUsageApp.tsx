import {useCallback, useEffect, useState, type ReactNode} from "react";

import {
  AdminCollectionLoading,
} from "@/components/admin/shared/AdminCollectionState";
import {Button} from "@/components/ui/button";
import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card";
import {formatAdminDateTime} from "@/client/admin-date-format";
import {useTranslation} from "@/client/i18n";
import Requests from "@/client/requests";
import {
  CLOUD_USAGE_UNAVAILABLE,
  type CloudUsageSnapshot,
  type UsagePeriod,
  type UsageSection,
} from "@/shared/CloudUsage";
import {ADMIN_URLS} from "@/shared/StringUtils";

import UsageCard from "./UsageCard";
import UsageTrendChart, {type TrendSeries} from "./UsageTrendChart";

/** 倒计时每分钟走一格；三张卡共用同一个时钟，避免各起一个定时器。 */
const COUNTDOWN_TICK_MS = 60_000;

type LoadState =
  | {status: "loading"}
  | {status: "failed"; message: string}
  | {status: "ready"; snapshot: CloudUsageSnapshot};

interface SnapshotResponse {
  ok?: boolean;
  data?: CloudUsageSnapshot;
  error?: string;
}

/** 从 axios 错误里取出服务端已本地化好的文案。 */
function errorMessage(error: unknown, fallback: string): string {
  const response = (error as {response?: {data?: {error?: string}}})?.response;
  return response?.data?.error || fallback;
}

function countdownParts(nextResetUtc: string, nowMs: number) {
  const remainingMs = Math.max(0, Date.parse(nextResetUtc) - nowMs);
  const totalMinutes = Math.floor(remainingMs / 60_000);
  return {
    days: Math.floor(totalMinutes / 1440),
    hours: Math.floor((totalMinutes % 1440) / 60),
    minutes: totalMinutes % 60,
  };
}

/** 分区头部的两行：计费周期与下次重置（含倒计时），时刻一律北京时间。 */
function PeriodLines({period, nowMs}: {period: UsagePeriod; nowMs: number}) {
  const {t} = useTranslation();
  return (
    <div className="grid gap-0.5 text-xs text-muted-foreground">
      <p>
        {t("cloudUsage.period.label", {
          from: formatAdminDateTime(period.startUtc),
          to: formatAdminDateTime(period.endUtc),
        })}
      </p>
      <p>
        {t("cloudUsage.period.nextReset", {
          time: formatAdminDateTime(period.nextResetUtc),
        })}
        {" "}
        {t("cloudUsage.period.countdown", countdownParts(period.nextResetUtc, nowMs))}
      </p>
    </div>
  );
}

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
        {period && <PeriodLines nowMs={nowMs} period={period} />}
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

/** 趋势图配色。三条线的含义靠图例文字区分，颜色只做辅助。 */
const PRIMARY_COLOR = "#2563eb";
const SECONDARY_COLOR = "#f59e0b";
const ERROR_COLOR = "#dc2626";

/**
 * Cloudflare 使用情况仪表盘（`/admin/cloud-usage`，migration 0123）。
 *
 * 打开时请求一次快照，四种界面：加载、整体失败（可重试）、引导态（未配置 /
 * 解不开 / 账号 ID 缺失）、正常三分区。分区级失败只在该分区顶部显示降级条。
 *
 * 所有时刻走 `formatAdminDateTime`（AGENTS.md「管理后台国际化」禁止
 * `Intl.DateTimeFormat` / `toLocaleString`）；服务端下发的都是带 `Z` 的 UTC 串，
 * 本组件不做任何手工时区加减。
 */
export default function CloudUsageApp() {
  const {t} = useTranslation();
  const [state, setState] = useState<LoadState>({status: "loading"});
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async () => {
    setState({status: "loading"});
    try {
      const response = await Requests.axiosGet(ADMIN_URLS.ajaxCloudUsage());
      const payload = response.data as SnapshotResponse;
      if (!payload.ok || !payload.data) {
        setState({
          status: "failed",
          message: payload.error || t("cloudUsage.failed"),
        });
        return;
      }
      setNowMs(Date.now());
      setState({status: "ready", snapshot: payload.data});
    } catch (error) {
      setState({
        status: "failed",
        message: errorMessage(error, t("cloudUsage.failed")),
      });
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), COUNTDOWN_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  if (state.status === "loading") {
    return <AdminCollectionLoading label={t("cloudUsage.loading")} />;
  }

  if (state.status === "failed") {
    return (
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-base">{t("cloudUsage.failed")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="text-sm" role="alert">{state.message}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void load()} type="button">{t("cloudUsage.retry")}</Button>
            <a
              className="text-sm text-brand-dark underline underline-offset-4 hover:no-underline"
              href={`${ADMIN_URLS.settings()}#cloudflare-token`}
            >
              {t("cloudUsage.settingsLink")}
            </a>
          </div>
        </CardContent>
      </Card>
    );
  }

  const {snapshot} = state;
  if (!snapshot.configured) {
    const reason = snapshot.unavailableKey ?? CLOUD_USAGE_UNAVAILABLE.notConfigured;
    // 账号 ID 不在设置页管理，这一态给设置页链接只会把人引到改不了它的地方。
    const fixableInSettings = reason !== CLOUD_USAGE_UNAVAILABLE.accountIdMissing;
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t(`cloudUsage.setup.${reason}Title`)}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="text-sm">{t(`cloudUsage.setup.${reason}`)}</p>
          {fixableInSettings && (
            <a
              className="text-sm text-brand-dark underline underline-offset-4 hover:no-underline"
              href={`${ADMIN_URLS.settings()}#cloudflare-token`}
            >
              {t("cloudUsage.setup.action")}
            </a>
          )}
        </CardContent>
      </Card>
    );
  }

  const d1Trend: TrendSeries[] = snapshot.d1.data
    ? [
      {
        labelKey: "cloudUsage.trend.rowsRead",
        color: PRIMARY_COLOR,
        values: snapshot.d1.data.trend.map((point) => point.rowsRead),
      },
      {
        labelKey: "cloudUsage.trend.rowsWritten",
        color: SECONDARY_COLOR,
        values: snapshot.d1.data.trend.map((point) => point.rowsWritten),
      },
    ]
    : [];
  const r2Trend: TrendSeries[] = snapshot.r2.data
    ? [
      {
        labelKey: "cloudUsage.trend.classA",
        color: PRIMARY_COLOR,
        values: snapshot.r2.data.trend.map((point) => point.classA),
      },
      {
        labelKey: "cloudUsage.trend.classB",
        color: SECONDARY_COLOR,
        values: snapshot.r2.data.trend.map((point) => point.classB),
      },
    ]
    : [];
  const workersTrend: TrendSeries[] = snapshot.workers.data
    ? [
      {
        labelKey: "cloudUsage.trend.requests",
        color: PRIMARY_COLOR,
        values: snapshot.workers.data.trend.map((point) => point.requests),
      },
      {
        labelKey: "cloudUsage.trend.errors",
        color: ERROR_COLOR,
        values: snapshot.workers.data.trend.map((point) => point.errors),
      },
    ]
    : [];

  const trendDates = (section: UsageSection<{trend: {date: string}[]}>) =>
    section.data?.trend.map((point) => point.date) ?? [];

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {t("cloudUsage.updatedAt", {time: formatAdminDateTime(snapshot.fetchedAt)})}
        </p>
        <Button onClick={() => void load()} size="sm" type="button" variant="outline">
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
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {snapshot.d1.data.cards.map((entry) => (
                <UsageCard card={entry} key={entry.key} onRetry={() => void load()} />
              ))}
            </div>
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
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {snapshot.r2.data.cards.map((entry) => (
                <UsageCard card={entry} key={entry.key} onRetry={() => void load()} />
              ))}
            </div>
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
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {snapshot.workers.data.cards.map((entry) => (
                <UsageCard card={entry} key={entry.key} onRetry={() => void load()} />
              ))}
            </div>
            <UsageTrendChart dates={trendDates(snapshot.workers)} series={workersTrend} />
          </>
        )}
      </SectionShell>
    </div>
  );
}
