import {AdminCollectionLoading} from "@/components/admin/shared/AdminCollectionState";
import {Button} from "@/components/ui/button";
import {Card, CardAction, CardContent, CardHeader, CardTitle} from "@/components/ui/card";
import {useTranslation} from "@/client/i18n";
import type {
  CloudUsageSnapshot,
  UsageCard as UsageCardData,
  UsagePeriod,
  UsageSection,
} from "@/shared/CloudUsage";

import UsageFailedCard from "./UsageFailedCard";
import UsagePeriodLines from "./UsagePeriodLines";
import UsageSectionGrid from "./UsageSectionGrid";
import UsageSetupCard from "./UsageSetupCard";
import {cloudUsageSetupState} from "./cloudUsageSetupState";
import {useCloudUsageSnapshot} from "./useCloudUsageSnapshot";

/**
 * 三分区数据的公共形状（D1 / R2 / Workers 各多带一个 trend，摘要条不画图，
 * 结构上收窄到周期与卡片即可复用同一个分区渲染）。
 */
type SummarySectionData = {period: UsagePeriod; cards: UsageCardData[]};

interface UsageSummaryBodyProps {
  snapshot: CloudUsageSnapshot;
  /** 倒计时基准时刻，由消费端的取数协调器推进 */
  nowMs: number;
  /** 头部「刷新」与单卡重试共用同一次重取 */
  refresh: () => void;
}

interface SummarySectionProps {
  titleKey: string;
  section: UsageSection<SummarySectionData>;
  nowMs: number;
  onRetry: () => void;
}

/**
 * 首页用量摘要条（`/admin/`，票据 02 + 03）：纯展示体。
 *
 * props 注入 `{snapshot, nowMs, refresh}`，只做渲染。ready 快照分两种：
 * 未配置（`configured` 为 false）走紧凑引导卡，reason 与设置页入口由共享判定
 * `cloudUsageSetupState` 给出（账号 ID 缺失不给设置页链接）；配置齐全时渲染
 * 三分区（D1 / R2 / Workers）各一个标题、一份周期两行、一张卡片网格，头部一个
 * 「刷新」按钮。趋势图、详情页跳转不在这层：趋势图是详情页专属。
 *
 * 与看板共用 `UsagePeriodLines` / `UsageSectionGrid`：全仓只有一份倒计时
 * 定时器与一份卡片网格，这层不另起一套。
 */
export function UsageSummaryBody({snapshot, nowMs, refresh}: UsageSummaryBodyProps) {
  const {t} = useTranslation();

  // 未配置 Token 的引导态：连周期都不渲染（服务端此时也不下发周期），
  // 改出紧凑引导卡，判定与详情页同源。
  if (!snapshot.configured) {
    const setup = cloudUsageSetupState(snapshot.unavailableKey);
    return (
      <UsageSetupCard
        compact
        fixableInSettings={setup.fixableInSettings}
        reason={setup.reason}
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("pageTitle.cloudUsage")}</CardTitle>
        <CardAction>
          <Button onClick={refresh} size="sm" type="button" variant="outline">
            {t("cloudUsage.refresh")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-5">
        <SummarySection
          nowMs={nowMs}
          onRetry={refresh}
          section={snapshot.d1}
          titleKey="cloudUsage.section.d1"
        />
        <SummarySection
          nowMs={nowMs}
          onRetry={refresh}
          section={snapshot.r2}
          titleKey="cloudUsage.section.r2"
        />
        <SummarySection
          nowMs={nowMs}
          onRetry={refresh}
          section={snapshot.workers}
          titleKey="cloudUsage.section.workers"
        />
      </CardContent>
    </Card>
  );
}

function SummarySection({titleKey, section, nowMs, onRetry}: SummarySectionProps) {
  const {t} = useTranslation();
  const data = section.available ? section.data : null;
  return (
    <section className="grid gap-2">
      <h3 className="text-sm font-semibold">{t(titleKey)}</h3>
      {data?.period && <UsagePeriodLines nowMs={nowMs} period={data.period} />}
      {data && <UsageSectionGrid cards={data.cards} onRetry={onRetry} />}
    </section>
  );
}

/**
 * 首页用量摘要条：薄消费端。只把取数 hook 的三态折成三种视图——加载中出
 * loading，整体失败出可重试的失败卡（重试与 ready 态「刷新」共用同一个
 * `refresh()`），就绪把快照交给纯展示体（引导态与正文由它按 `configured` 分）。
 */
export default function UsageSummaryStrip() {
  const {t} = useTranslation();
  const {state, nowMs, refresh} = useCloudUsageSnapshot();

  if (state.status === "failed") {
    return <UsageFailedCard compact message={state.message} onRetry={refresh} />;
  }

  if (state.status !== "ready") {
    return <AdminCollectionLoading label={t("cloudUsage.loading")} />;
  }

  return <UsageSummaryBody nowMs={nowMs} refresh={refresh} snapshot={state.snapshot} />;
}
