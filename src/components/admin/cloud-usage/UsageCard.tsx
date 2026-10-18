import {formatAdminDateTime} from "@/client/admin-date-format";
import {useTranslation} from "@/client/i18n";
import {Button} from "@/components/ui/button";
import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card";
import type {UsageCard as UsageCardData} from "@/shared/CloudUsage";

interface Props {
  card: UsageCardData;
  /** 单卡不可用时提供重试入口；不传则只显示「暂不可用」 */
  onRetry?: () => void;
}

/**
 * 单张指标卡。三分区共用这一个组件，避免同一套「标题 / 数值 / 进度条 / 附注」
 * 在三个分区各写一遍。
 *
 * 进度条分级按中国区习惯：常规色，≥ 80% 琥珀，超额红色。`limit` 为 null 的卡片
 * （错误数、子请求、CPU、计量存储折算）不画进度条——没有分母的百分比是噪音。
 *
 * 单卡降级（例如 REST 列库失败只影响「数据库总数」这一张）给一个重试入口，
 * 其余卡片正常时不必为它整个刷新页面。
 */
export default function UsageCard({card, onRetry}: Props) {
  const {t} = useTranslation();
  const percent = card.limit !== null && card.limit > 0
    ? Math.min(100, (card.value / card.limit) * 100)
    : null;
  // 分级按百分比判，恰好用满额度即红色：`percent` 已被截到 100，
  // 所以「等于上限」与「超过上限」归入同一档。`overLimit` 由服务端在严格超额时置位，
  // 两者取或，边界两侧都不会漏红。
  const overLimit = card.overLimit || (percent !== null && percent >= 100);
  const barClass = percent === null
    ? "bg-brand-light"
    : overLimit
      ? "bg-destructive"
      : percent >= 80
        ? "bg-amber-500"
        : "bg-brand-light";

  const notes: string[] = [];
  if (card.unavailableKey) notes.push(t("cloudUsage.cardUnavailable"));
  if (card.noteKey) notes.push(t(card.noteKey, {...card.noteParams}));
  if (card.asOfUtc) {
    notes.push(t("cloudUsage.note.asOf", {time: formatAdminDateTime(card.asOfUtc)}));
  }

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="gap-1 border-b px-4 py-3">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {t(`cloudUsage.cards.${card.key}`)}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 px-4 py-3">
        <p className="text-2xl font-semibold tabular-nums">{card.display}</p>
        {percent !== null && (
          <div
            aria-label={t("cloudUsage.limit", {limit: card.limitDisplay ?? ""})}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={Math.round(percent)}
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
          >
            <div className={`h-full rounded-full ${barClass}`} style={{width: `${percent}%`}} />
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {card.limitDisplay
            ? t("cloudUsage.limit", {limit: card.limitDisplay})
            : t("cloudUsage.noLimit")}
          {percent !== null ? ` · ${percent.toFixed(1)}%` : ""}
        </p>
        {notes.map((note) => (
          <p className="text-xs text-muted-foreground" key={note}>{note}</p>
        ))}
        {card.unavailableKey && onRetry && (
          <Button
            className="justify-self-start"
            onClick={onRetry}
            size="xs"
            type="button"
            variant="outline"
          >
            {t("cloudUsage.retry")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
