/**
 * 两处降级卡（引导态 / 整体失败）共用的尺寸与类名。
 *
 * 详情页与首页摘要都渲染这两张卡，只差一个「紧凑」开关；尺寸旋钮只有这一份，
 * 两处卡各自枚举 compact 三元表达式会让两套尺寸各自演化、渐渐对不上。
 */

/** 设置页入口链接的共用类名（深品牌色 + 悬停去下划线）。 */
export const SETTINGS_LINK_CLASS =
  "text-brand-dark underline underline-offset-4 hover:no-underline";

export interface DegradedTone {
  cardSize: "sm" | "default";
  titleText: string;
  bodyText: string;
  contentGap: string;
  linkText: string;
  buttonSize: "sm" | "default";
}

/** 紧凑开关到一组尺寸/字号的映射；未传按详情页默认尺寸。 */
export function degradedTone(compact?: boolean): DegradedTone {
  return compact
    ? {
      cardSize: "sm",
      titleText: "text-sm",
      bodyText: "text-xs",
      contentGap: "grid gap-2",
      linkText: "text-xs",
      buttonSize: "sm",
    }
    : {
      cardSize: "default",
      titleText: "text-base",
      bodyText: "text-sm",
      contentGap: "grid gap-3",
      linkText: "text-sm",
      buttonSize: "default",
    };
}
