import {formatAdminDateTime} from "@/client/admin-date-format";
import {useTranslation} from "@/client/i18n";

export interface TrendSeries {
  /** 图例文案的 i18n 键 */
  labelKey: string;
  /** 描边颜色（CSS 颜色值） */
  color: string;
  /** 与 `dates` 等长的数值 */
  values: number[];
}

interface Props {
  /** 横轴日期（UTC 日期 `YYYY-MM-DD`），与每个 series 的 values 等长 */
  dates: string[];
  series: TrendSeries[];
}

const WIDTH = 640;
const HEIGHT = 120;
const PADDING_X = 6;
const PADDING_TOP = 10;
const PADDING_BOTTOM = 6;
const DAY_MS = 86_400_000;

/** 某个 UTC 计费日的起始时刻（00:00Z）。 */
function dayStart(date: string): string {
  return `${date}T00:00:00Z`;
}

/** 该计费日的结束时刻（次日 00:00Z，开区间）。 */
function dayEnd(date: string): string {
  return new Date(Date.parse(dayStart(date)) + DAY_MS).toISOString();
}

/**
 * 迷你趋势图。纯 SVG，不引图表库。
 *
 * 横轴只标首、中、末三个刻度：这条轴的作用是「看出形状与量级」，读精确时刻
 * 交给 tooltip；密集刻度在窄卡片里只会互相压住。刻度放在 SVG 外面用 HTML 排，
 * 因为图形按容器宽度拉伸（`preserveAspectRatio="none"`），SVG 内的文字会被拉变形。
 *
 * 刻度文案取自 `formatAdminDateTime` 的日期部分：完整时刻是 19 个字符，三个并排
 * 放不进窄卡片；日期部分仍是这个 helper 按本地时区算出的计费日起始日，
 * 不受语言与系统设置影响（AGENTS.md「管理后台国际化」禁止 `Intl` / `toLocaleString`）。
 * 完整区间（起始 ~ 结束，本地时区）放在每个数据点的 tooltip 里。
 *
 * 每个数据点的原生 `<title>` 给出「计费日区间 + 序列名 + 数值」，悬停即可读具体值。
 */
export default function UsageTrendChart({dates, series}: Props) {
  const {t} = useTranslation();
  const maxValue = Math.max(1, ...series.flatMap((entry) => entry.values));
  const plotWidth = WIDTH - PADDING_X * 2;
  const plotHeight = HEIGHT - PADDING_TOP - PADDING_BOTTOM;
  const step = dates.length > 1 ? plotWidth / (dates.length - 1) : 0;

  const pointX = (index: number) => PADDING_X + step * index;
  const pointY = (value: number) =>
    PADDING_TOP + plotHeight - (value / maxValue) * plotHeight;

  const ticks = dates.length <= 1
    ? [0]
    : [0, Math.floor((dates.length - 1) / 2), dates.length - 1];

  const tickLabel = (index: number) => {
    const date = dates[index];
    return date ? formatAdminDateTime(dayStart(date)).slice(0, 10) : "";
  };

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        {series.map((entry) => (
          <span className="inline-flex items-center gap-1.5" key={entry.labelKey}>
            <span
              aria-hidden="true"
              className="inline-block size-2 rounded-full"
              style={{backgroundColor: entry.color}}
            />
            {t(entry.labelKey)}
          </span>
        ))}
      </div>
      <svg
        aria-label={series.map((entry) => t(entry.labelKey)).join(" / ")}
        className="h-28 w-full"
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      >
        <line
          stroke="currentColor"
          strokeOpacity="0.15"
          x1={PADDING_X}
          x2={WIDTH - PADDING_X}
          y1={PADDING_TOP + plotHeight}
          y2={PADDING_TOP + plotHeight}
        />
        {series.map((entry) => (
          <g key={entry.labelKey}>
            <polyline
              fill="none"
              points={entry.values
                .map((value, index) => `${pointX(index)},${pointY(value)}`)
                .join(" ")}
              stroke={entry.color}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
            {entry.values.map((value, index) => {
              const date = dates[index] ?? "";
              const range = date
                ? `${formatAdminDateTime(dayStart(date))} ~ ${formatAdminDateTime(dayEnd(date))}`
                : "";
              return (
                <circle
                  cx={pointX(index)}
                  cy={pointY(value)}
                  fill={entry.color}
                  key={`${entry.labelKey}-${date || index}`}
                  r="2.5"
                >
                  <title>{`${range} · ${t(entry.labelKey)}: ${value}`}</title>
                </circle>
              );
            })}
          </g>
        ))}
      </svg>
      <div className="grid grid-cols-3 text-[10px] text-muted-foreground">
        {ticks.map((index, position) => (
          <span
            className={
              position === 0
                ? "text-left"
                : position === ticks.length - 1
                  ? "text-right"
                  : "text-center"
            }
            key={`tick-${index}`}
          >
            {tickLabel(index)}
          </span>
        ))}
      </div>
    </div>
  );
}
