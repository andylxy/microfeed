/**
 * 邮件模板的占位符规则（邮箱 + 验证码注册 §3.2 / §3.8）。
 *
 * 服务端渲染验证码邮件、后台「邮件设置」卡片做预览，都要把 `{{code}}` /
 * `{{expireMinutes}}` 换成示例值。规则放在这里，两边读同一份定义——预览与实际
 * 发出去的邮件不会因为各写一套替换而出现差异。
 */

/** 验证码占位符。 */
export const PLACEHOLDER_CODE = "{{code}}";
/** 有效期分钟数占位符。 */
export const PLACEHOLDER_EXPIRE_MINUTES = "{{expireMinutes}}";

/**
 * 占位符替换（替换所有出现位置）。
 *
 * 用 split/join 做替换：`String.replace` 会把替换串里的 `$&` 之类当成特殊模式
 * 解释，而模板允许后台自由编辑，出现这种字符时内容会被改写。split/join 是纯
 * 字面量替换，语义稳定。
 */
export function applyPlaceholders(
  template: string,
  code: string,
  expireMinutes: number,
): string {
  return template
    .split(PLACEHOLDER_CODE)
    .join(code)
    .split(PLACEHOLDER_EXPIRE_MINUTES)
    .join(String(expireMinutes));
}

/** 取模板值：空串 / 空白 / 非字符串一律回落默认值。 */
export function pickTemplateValue(
  configured: string | null | undefined,
  fallback: string,
): string {
  if (typeof configured !== "string") return fallback;
  if (configured.trim() === "") return fallback;
  return configured;
}
