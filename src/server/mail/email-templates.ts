/**
 * 发信模板渲染层（邮箱 + 验证码注册 §3.2）。
 *
 * 职责只有一件事：把「服务端生成的验证码 + 有效期」填进模板占位符，产出
 * `{subject, html}` 交给传输层 {@link module:resend}。它不发信、不碰 env、
 * 不读库——模板内容由调用方（后台「邮件设置」）通过 settings 注入。
 *
 * 安全边界：这里**只做占位符字符串替换**，永远不拼接用户输入。验证码是服务端
 * 随机生成的 6 位数字，有效期是常量，二者都不含 HTML 元字符，因此不存在注入面。
 * 若将来要支持把用户昵称等外部值填进正文，必须改为 HTML 转义后再替换。
 */

import {
  applyPlaceholders,
  pickTemplateValue,
} from "@/shared/EmailTemplatePlaceholders";

/** 模板两段：主题与正文（HTML）。缺省值与后台可编辑值同形状。 */
export interface OtpEmailTemplate {
  subject: string;
  bodyHtml: string;
}

/**
 * 渲染所需的模板来源。字段可选且允许为空串——后台未配置 / 清空某项时回落默认模板，
 * 保证本地 dev 与未配置实例都能发出一封可读的邮件（ADR §3.8）。
 */
export interface OtpEmailTemplateSettings {
  subjectTemplate?: string | null;
  bodyTemplate?: string | null;
}

/** 渲染结果：直接对应 Resend 的 subject / html 两个字段。 */
export interface RenderedOtpEmail {
  subject: string;
  html: string;
}

/** 支持的占位符与替换规则定义在 `src/shared/EmailTemplatePlaceholders.ts`——
 * 后台预览卡片读同一份，避免预览与实际发信各写一套。 */

/**
 * 出厂默认模板（单一默认源）。
 * 邮件客户端对 CSS 支持极差，故全部内联样式、table 布局、无外部资源：
 * 断网 / 屏蔽远程图片时依然可读，验证码是唯一必须看清的信息。
 */
export const DEFAULT_OTP_EMAIL_TEMPLATE: OtpEmailTemplate = {
  subject: "您的邮箱注册验证码",
  bodyHtml: [
    '<div style="background:#f6f6f6;padding:24px 0;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,\'Helvetica Neue\',Arial,sans-serif;">',
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;">',
    '<tr><td style="padding:32px 32px 8px 32px;color:#1f2328;font-size:18px;font-weight:600;">邮箱注册验证码</td></tr>',
    '<tr><td style="padding:0 32px 8px 32px;color:#57606a;font-size:14px;line-height:22px;">',
    "您正在进行邮箱注册，请在 App 中输入下方验证码完成验证。",
    "</td></tr>",
    '<tr><td style="padding:16px 32px;">',
    '<div style="background:#f0f4ff;border:1px solid #d7e0ff;border-radius:6px;padding:16px;text-align:center;',
    'font-size:32px;letter-spacing:8px;font-weight:700;color:#1f3a93;">{{code}}</div>',
    "</td></tr>",
    '<tr><td style="padding:0 32px 8px 32px;color:#57606a;font-size:13px;line-height:20px;">',
    "验证码 {{expireMinutes}} 分钟内有效，逾期请重新获取。",
    "</td></tr>",
    '<tr><td style="padding:0 32px 24px 32px;color:#8c959f;font-size:12px;line-height:18px;">',
    "如果这不是您本人的操作，请忽略本邮件，您的账号不会受到影响。",
    "</td></tr>",
    "</table>",
    "</div>",
  ].join(""),
};

/**
 * 渲染验证码邮件。
 *
 * @param settings 后台「邮件设置」的模板来源；传 null / 缺字段都安全，回落默认模板。
 * @param code 服务端生成的 6 位验证码（非用户输入）。
 * @param expireMinutes 有效期分钟数，用于正文提示。
 */
export function renderOtpEmail(
  settings: OtpEmailTemplateSettings | null | undefined,
  code: string,
  expireMinutes: number,
): RenderedOtpEmail {
  const subject = pickTemplateValue(
    settings?.subjectTemplate,
    DEFAULT_OTP_EMAIL_TEMPLATE.subject,
  );
  const bodyHtml = pickTemplateValue(
    settings?.bodyTemplate,
    DEFAULT_OTP_EMAIL_TEMPLATE.bodyHtml,
  );
  return {
    subject: applyPlaceholders(subject, code, expireMinutes),
    html: applyPlaceholders(bodyHtml, code, expireMinutes),
  };
}
