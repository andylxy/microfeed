import {useCallback, useEffect, useState} from "react";

import AdminInput from "@/components/admin/shared/AdminInput";
import AdminTextarea from "@/components/admin/shared/AdminTextarea";
import {formatAdminDateTime} from "@/client/admin-date-format";
import {useTranslation} from "@/client/i18n";
import Requests from "@/client/requests";
import {errorMessage} from "@/client/request-error";
import {showToast} from "@/client/ToastUtils";
import {
  applyPlaceholders,
  pickTemplateValue,
} from "@/shared/EmailTemplatePlaceholders";
import type {MailSettingsConfig} from "@/shared/MailSettings";
import {ADMIN_URLS} from "@/shared/StringUtils";
import SettingsBase from "../SettingsBase";

/** 保存按钮的提交键：与 `SettingsApp` 的 `submitForType` 同一口径。 */
export const MAIL_SETTINGS_SUBMIT_KEY = "mail-settings";

/** 预览用的示例验证码与有效期：与真实发信的取值形状一致，不参与保存。 */
const PREVIEW_CODE = "123456";
const PREVIEW_EXPIRE_MINUTES = 10;

interface MailSettingsResponse {
  config: MailSettingsConfig;
  /** 出厂模板：占位符文案的取值来源，只用于占位与说明，不回写。 */
  defaults: {subjectTemplate: string; bodyTemplate: string};
  /** 发信通道现状：密钥在 Workers secret 里，后台只读布尔。 */
  delivery: {apiKeyConfigured: boolean; fallbackFrom: string};
}

/** 表单草稿：四个字段都可为空串（= 用出厂默认）。 */
type Draft = Pick<
  MailSettingsConfig,
  "fromAddress" | "fromName" | "subjectTemplate" | "bodyTemplate"
>;

const EMPTY_DRAFT: Draft = {
  fromAddress: "",
  fromName: "",
  subjectTemplate: "",
  bodyTemplate: "",
};

function draftOf(config: MailSettingsConfig): Draft {
  return {
    fromAddress: config.fromAddress,
    fromName: config.fromName,
    subjectTemplate: config.subjectTemplate,
    bodyTemplate: config.bodyTemplate,
  };
}

/**
 * 站点设置 → 邮件设置（邮箱 + 验证码注册的發信口）。
 *
 * 即时保存：这个分区自带请求与 toast，不走 `SettingsApp.onSubmit` 的通用路径
 * ——通用路径把客户端 JSON 原样 upsert 进 settings 表，而邮件设置要由服务端
 * 补 `updatedAtMs` / `updatedBy` 并逐字段校验类型（`saveMailSettingsConfig`），
 * 客户端不该有机会伪造这两个字段。
 *
 * **空串是合法值**：四个字段留空一律解释为「用出厂默认」，不是「没填」。
 * 因此不校验非空、也不禁用保存按钮——清空一条模板本身就是要保存的指令。
 *
 * Resend API Key 不在这里录入：它走 Workers secret（`wrangler secret put`），
 * 后台只显示「已配置 / 未配置」，未配置时明确提示验证码邮件发不出去。
 */
export default function MailSettingsApp() {
  const {t} = useTranslation();
  const [config, setConfig] = useState<MailSettingsConfig | null>(null);
  const [defaults, setDefaults] = useState<MailSettingsResponse["defaults"]>({
    subjectTemplate: "",
    bodyTemplate: "",
  });
  const [delivery, setDelivery] = useState<MailSettingsResponse["delivery"]>({
    apiKeyConfigured: false,
    fallbackFrom: "",
  });
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await Requests.axiosGet(ADMIN_URLS.ajaxMailSettings());
      const payload = response.data as MailSettingsResponse;
      setConfig(payload.config);
      setDefaults(payload.defaults);
      setDelivery(payload.delivery);
      setDraft(draftOf(payload.config));
      setLoadFailed(false);
    } catch (error) {
      setLoadFailed(true);
      showToast(
        errorMessage(error, t("settings.mailSettingsLoadFailed")),
        "error",
      );
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (event?: {preventDefault?: () => void}) => {
    event?.preventDefault?.();
    setBusy(true);
    try {
      await Requests.axiosPost(ADMIN_URLS.ajaxMailSettingsSave(), {
        patch: draft,
      });
      // 以服务端回读为准：updatedAtMs / updatedBy 只有服务端知道。
      await load();
      showToast(t("settings.mailSettingsSaved"), "success");
    } catch (error) {
      showToast(
        errorMessage(error, t("settings.mailSettingsSaveFailed")),
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  const setField = (key: keyof Draft, value: string) => {
    setDraft((previous) => ({...previous, [key]: value}));
  };

  // 预览随输入实时变化：替换规则与发信时同一份（`applyPlaceholders`），所以「预览
  // 看到什么」就是「用户收到什么」的骨架，只是验证码换成了示例值。
  const previewSubject = applyPlaceholders(
    pickTemplateValue(draft.subjectTemplate, defaults.subjectTemplate),
    PREVIEW_CODE,
    PREVIEW_EXPIRE_MINUTES,
  );
  const previewHtml = applyPlaceholders(
    pickTemplateValue(draft.bodyTemplate, defaults.bodyTemplate),
    PREVIEW_CODE,
    PREVIEW_EXPIRE_MINUTES,
  );

  const savedLine = loadFailed
    ? t("settings.mailSettingsLoadFailed")
    : config && config.updatedAtMs > 0
      ? t("settings.mailSettingsSavedAt", {
        time: formatAdminDateTime(config.updatedAtMs),
        user: config.updatedBy ?? "—",
      })
      : t("settings.mailSettingsNeverSaved");

  return (<SettingsBase
    currentType={MAIL_SETTINGS_SUBMIT_KEY}
    description={t("settings.mailSettingsDescription")}
    onSubmit={save}
    // `submitForType` 必须跟着 busy 走：SettingsBase 判「本键是否正在提交」只看
    // `submitForType === currentType`，写死成常量会让按钮从首帧起就显示「正在更新」
    // 并保持 disabled（本卡片自带保存流程，没有 SettingsApp 的 null → 键 过渡）。
    submitForType={busy ? MAIL_SETTINGS_SUBMIT_KEY : null}
    submitting={busy}
    title={t("settings.mailSettings")}
  >
    <div className="grid gap-5">
      <div
        aria-live="polite"
        className={[
          "rounded-lg border px-3 py-2 text-sm",
          loadFailed
            ? "border-destructive/40 bg-destructive/10 text-destructive"
            : delivery.apiKeyConfigured
              ? "border-brand-light/40 bg-brand-light/10 font-medium text-foreground"
              : "border-destructive/40 bg-destructive/10 text-destructive",
        ].join(" ")}
      >
        {delivery.apiKeyConfigured
          ? t("settings.mailSettingsDeliveryReady", {
            from: delivery.fallbackFrom || t("settings.mailSettingsNoFallback"),
          })
          : t("settings.mailSettingsDeliveryMissing")}
      </div>
      <p className="text-xs text-helper-color">{t("settings.mailSettingsIntro")}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <AdminInput
          disabled={busy}
          label={t("settings.mailSettingsFromAddress")}
          placeholder={delivery.fallbackFrom || "no-reply@example.com"}
          value={draft.fromAddress}
          onChange={(event: any) => setField("fromAddress", event.target.value)}
        />
        <AdminInput
          disabled={busy}
          label={t("settings.mailSettingsFromName")}
          placeholder={t("settings.mailSettingsFromNamePlaceholder")}
          value={draft.fromName}
          onChange={(event: any) => setField("fromName", event.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <AdminTextarea
          customCss="font-mono text-sm"
          disabled={busy}
          label={t("settings.mailSettingsSubjectTemplate")}
          minRows={2}
          placeholder={defaults.subjectTemplate}
          value={draft.subjectTemplate}
          onChange={(event: any) => setField("subjectTemplate", event.target.value)}
        />
        <p className="text-xs leading-5 text-muted-foreground">
          {t("settings.mailSettingsTemplateHint")}
        </p>
      </div>
      <div className="grid gap-2">
        <AdminTextarea
          customCss="font-mono text-sm"
          disabled={busy}
          label={t("settings.mailSettingsBodyTemplate")}
          maxRows={18}
          minRows={8}
          placeholder={defaults.bodyTemplate}
          value={draft.bodyTemplate}
          onChange={(event: any) => setField("bodyTemplate", event.target.value)}
        />
        <p className="text-xs leading-5 text-muted-foreground">
          {t("settings.mailSettingsBodyHint")}
        </p>
      </div>
      <div className="grid gap-2">
        <p className="text-sm font-medium">{t("settings.mailSettingsPreview")}</p>
        <p className="rounded-lg border border-line px-3 py-2 text-sm text-foreground">
          {t("settings.mailSettingsPreviewSubject", {subject: previewSubject})}
        </p>
        {/* 正文按真实邮件渲染在沙箱 iframe 里：后台模板允许写 HTML，直接插进
            页面会让模板里的脚本在管理端执行。sandbox 留空即禁脚本。 */}
        <iframe
          className="h-72 w-full rounded-lg border border-line bg-white"
          sandbox=""
          srcDoc={previewHtml}
          title={t("settings.mailSettingsPreview")}
        />
        <p className="text-xs leading-5 text-muted-foreground">
          {t("settings.mailSettingsPreviewHint")}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">{savedLine}</p>
    </div>
  </SettingsBase>);
}
