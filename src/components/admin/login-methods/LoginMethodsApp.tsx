import {useCallback, useEffect, useState} from "react";

import {Button} from "@/components/ui/button";
import {Switch} from "@/components/ui/switch";
import {useTranslation} from "@/client/i18n";
import {formatAdminDateTime} from "@/client/admin-date-format";
import {
  AdminCollectionError,
  AdminCollectionLoading,
} from "@/components/admin/shared/AdminCollectionState";
import {ADMIN_URLS} from "@/shared/StringUtils";
import type {
  LoginMethodsConfig,
  LoginMethodToggleKey,
} from "@/shared/AppLoginMethods";

interface BoardResponse {
  config?: LoginMethodsConfig;
  error?: string;
}

interface Props {
  /** `system:app-login-methods:manage`；无此码的账号看不到保存按钮。 */
  canManage?: boolean;
}

/**
 * 行清单：顺序即页面展示顺序（账号密码 / 验证码 / 短信 / 微信 / QQ，方案 §1）。
 * `reserved` 的三行本期只控显隐、后端未接通（ADR-0050），渲染为禁用态 + 角标，
 * 不虚标能登录。
 */
const ROWS: Array<{
  key: LoginMethodToggleKey;
  labelKey: string;
  reserved: boolean;
}> = [
  {key: "loginEnabled", labelKey: "appLoginMethods.labelLogin", reserved: false},
  {key: "accountPasswordEnabled", labelKey: "appLoginMethods.labelAccount", reserved: false},
  {key: "captchaEnabled", labelKey: "appLoginMethods.labelCaptcha", reserved: false},
  {key: "smsEnabled", labelKey: "appLoginMethods.labelSms", reserved: true},
  {key: "wechatEnabled", labelKey: "appLoginMethods.labelWechat", reserved: true},
  {key: "qqEnabled", labelKey: "appLoginMethods.labelQq", reserved: true},
];

/**
 * App 登录管理板（`/admin/login-methods/`，ADR-0050）。控制 App 登录页的
 * 登录方式显隐与图形验证码强制；配置存 `settings` 表单行 JSON，App 侧经
 * `getLoginMethods`（2h 缓存）读取、`appLogin` 强制执行。保存是
 * read-merge-write：只提交用户翻动过的开关。
 */
export default function LoginMethodsApp({canManage = false}: Props) {
  const {t} = useTranslation();
  const [config, setConfig] = useState<LoginMethodsConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState<Partial<Record<LoginMethodToggleKey, boolean>>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxLoginMethods());
      const data = await response.json().catch(() => ({})) as BoardResponse;
      if (!response.ok) {
        throw new Error(data.error ?? t("appLoginMethods.loadFailed"));
      }
      setConfig(data.config ?? null);
      setDirty({});
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("appLoginMethods.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    if (!config) return;
    setBusy(true);
    setSaved(false);
    setSaveError(null);
    try {
      const response = await fetch(ADMIN_URLS.ajaxLoginMethodsSave(), {
        body: JSON.stringify({patch: dirty}),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      const data = await response.json().catch(() => ({})) as {error?: string};
      if (!response.ok) {
        throw new Error(data.error ?? t("appLoginMethods.saveFailed"));
      }
      await load();
      setSaved(true);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : t("appLoginMethods.saveFailed"));
    } finally {
      setBusy(false);
    }
  }, [config, dirty, load, t]);

  if (loading) {
    return <AdminCollectionLoading label={t("appLoginMethods.title")} />;
  }
  if (error || !config) {
    return (
      <AdminCollectionError
        message={error ?? t("appLoginMethods.loadFailed")}
        retry={() => void load()}
      />
    );
  }

  const dirtyCount = Object.keys(dirty).length;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t("appLoginMethods.intro")}</p>
      <div className="flex flex-col gap-2">
        {ROWS.map((row) => (
          <label className="flex items-center gap-2 text-sm" key={row.key}>
            <Switch
              checked={dirty[row.key] ?? config[row.key]}
              disabled={row.reserved}
              onCheckedChange={(checked) => {
                if (row.reserved) return;
                setDirty((current) => ({...current, [row.key]: checked}));
                setSaved(false);
                setSaveError(null);
              }}
            />
            <span>{t(row.labelKey)}</span>
            {row.reserved ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {t("appLoginMethods.reservedBadge")}
              </span>
            ) : null}
          </label>
        ))}
      </div>
      {canManage ? (
        <div className="flex items-center gap-3">
          <Button disabled={busy || dirtyCount === 0} onClick={() => void save()} type="button">
            {t("appLoginMethods.save")}
          </Button>
          {saved ? <span className="text-sm text-muted-foreground">{t("appLoginMethods.saved")}</span> : null}
          {saveError ? <span className="text-sm text-destructive">{saveError}</span> : null}
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {t("appLoginMethods.lastSaved")}
        {"："}
        {config.updatedAtMs > 0
          ? formatAdminDateTime(config.updatedAtMs)
          : t("appLoginMethods.neverSaved")}
      </p>
    </div>
  );
}
