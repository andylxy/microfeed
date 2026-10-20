import {formatAdminDateTime} from "@/client/admin-date-format";
import {useTranslation} from "@/client/i18n";
import type {UsagePeriod} from "@/shared/CloudUsage";

/** 倒计时的日 / 时 / 分三段，直接作为 `cloudUsage.period.countdown` 的插值参数。 */
export function countdownParts(nextResetUtc: string, nowMs: number) {
  const remainingMs = Math.max(0, Date.parse(nextResetUtc) - nowMs);
  const totalMinutes = Math.floor(remainingMs / 60_000);
  return {
    days: Math.floor(totalMinutes / 1440),
    hours: Math.floor((totalMinutes % 1440) / 60),
    minutes: totalMinutes % 60,
  };
}

/** 分区头部的两行：计费周期与下次重置（含倒计时），时刻一律北京时间。 */
export default function UsagePeriodLines({
  period,
  nowMs,
}: {
  period: UsagePeriod;
  nowMs: number;
}) {
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
