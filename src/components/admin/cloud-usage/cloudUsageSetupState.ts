import {CLOUD_USAGE_UNAVAILABLE} from "@/shared/CloudUsage";

/**
 * 引导态（未配置 Token / 密文解不开 / 账号 ID 缺失）的共用判定结果。
 */
export interface CloudUsageSetupState {
  /** 引导态细分原因，作为 `cloudUsage.setup.*` 文案键的后缀 */
  reason: string;
  /** 该原因能否在站点设置页处理；false 时界面不给设置页入口 */
  fixableInSettings: boolean;
}

/**
 * 纯判定：从快照的 `unavailableKey` 推出引导态原因与「能否在设置页处理」。
 * 详情页 CloudUsageApp 与首页摘要都从这里取，引导态语义只有这一份。
 * 缺省原因按未配置处理；未知键原样透过（文案层按缺键显示键名，不猜语义）。
 */
export function cloudUsageSetupState(unavailableKey?: string): CloudUsageSetupState {
  const reason = unavailableKey ?? CLOUD_USAGE_UNAVAILABLE.notConfigured;
  // 账号 ID 不在设置页管理，这一态给设置页链接只会把人引到改不了它的地方。
  const fixableInSettings = reason !== CLOUD_USAGE_UNAVAILABLE.accountIdMissing;
  return {reason, fixableInSettings};
}
