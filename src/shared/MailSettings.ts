/**
 * 邮件设置的类型与默认值（邮箱 + 验证码注册 §3.8）。
 *
 * 放在 `src/shared/` 是因为两边都要用：服务端 `mail-config.ts` 读写它，后台
 * 「邮件设置」卡片渲染表单也读它。以前这个接口在服务端与组件里各写一份，加字段
 * 时两处就得手动对齐，漏一处只会在运行时表现为「保存了但表单看不到」。
 *
 * 这里只放类型与纯数据，不含 IO（读写走 `src/server/mail/mail-config.ts`）。
 */

export interface MailSettingsConfig {
  /** 发信地址，如 `no-reply@example.com`。空串 = 未配置，调用方回落 `env.RESEND_FROM`。 */
  fromAddress: string;
  /** 发信人显示名。空串 = 不拼显示名，直接用裸地址。 */
  fromName: string;
  /** 邮件主题模板，支持 `{{code}}` / `{{expireMinutes}}` 占位符。空串回落出厂模板。 */
  subjectTemplate: string;
  /** 邮件正文模板（HTML），同上。空串回落出厂模板。 */
  bodyTemplate: string;
  updatedAtMs: number;
  updatedBy: string | null;
}

/**
 * SSOT 单一默认源：全空 = 「后台没配过」。四个模板/地址字段的空串都是**合法**
 * 状态，由消费方（`renderOtpEmail` / 发信地址解析）各自回落到出厂值，保证本地
 * dev 与未配置实例都能发出一封可用的邮件。
 */
export const DEFAULT_MAIL_SETTINGS: MailSettingsConfig = {
  fromAddress: "",
  fromName: "",
  subjectTemplate: "",
  bodyTemplate: "",
  updatedAtMs: 0,
  updatedBy: null,
};

/** 保存请求允许携带的字段。 */
export type MailSettingsPatch = Partial<
  Record<"fromAddress" | "fromName" | "subjectTemplate" | "bodyTemplate", unknown>
>;
