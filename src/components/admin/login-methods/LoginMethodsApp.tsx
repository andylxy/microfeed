import {useCallback, useEffect, useState} from "react";

import {Button} from "@/components/ui/button";
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "@/components/ui/card";
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
 * 登录方式行清单：顺序即页面展示顺序（账号密码 / 验证码 / 短信 / 微信 / QQ，方案 §1）。
 * 短信 / 微信 两行后端尚未接通，但开关现已可手动拨动——打开后 App 登录页即展示对应入口，
 * 实际登录失败由服务端返回「该登录方式已停用」（管理员已知后端未接通）。QQ 已接通服务端
 * （`/api/AppBookRequest/thirdPartyLogin` + `verifyQqToken` 真实校验腾讯 accessToken），
 * 开关置 `true` 后 App 登录页出现 QQ 入口，点进去能真正完成登录。
 */
const LOGIN_ROWS: Array<{
  key: LoginMethodToggleKey;
  labelKey: string;
}> = [
  {key: "loginEnabled", labelKey: "appLoginMethods.labelLogin"},
  {key: "accountPasswordEnabled", labelKey: "appLoginMethods.labelAccount"},
  {key: "captchaEnabled", labelKey: "appLoginMethods.labelCaptcha"},
  {key: "smsEnabled", labelKey: "appLoginMethods.labelSms"},
  {key: "wechatEnabled", labelKey: "appLoginMethods.labelWechat"},
  {key: "qqEnabled", labelKey: "appLoginMethods.labelQq"},
];

/**
 * 注册方式行清单：`emailRegisterEnabled` 是邮箱注册开关、`smsRegisterEnabled` 是
 * 手机号注册开关（默认开）。两者都读 `getLoginMethods`，App 注册页按各自开关
 * 逐个显隐入口。手机号注册是注册页默认（原始）流程，microfeed 尚未实现短信
 * 链路（提交 404），后台开关目前只控**显隐**——服务端行为未接通。
 *
 * 邮箱注册是硬门在服务端（发码 / 校验 / 建号三端点读 `emailRegisterEnabled`，
 * 关掉即「邮箱注册暂未开放」），默认 false，须后台显式打开。
 */
const REGISTER_ROWS: Array<{
  key?: LoginMethodToggleKey;
  labelKey: string;
}> = [
  {key: "smsRegisterEnabled", labelKey: "appLoginMethods.labelPhoneRegister"},
  {key: "emailRegisterEnabled", labelKey: "appLoginMethods.labelEmailRegister"},
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

  const renderRows = (
    rows: Array<{key?: LoginMethodToggleKey; labelKey: string}>,
  ) => (
    <div className="flex flex-col gap-2">
      {rows.map((row) => (
        <label className="flex items-center gap-2 text-sm" key={row.labelKey}>
          <Switch
            checked={row.key ? (dirty[row.key] ?? config[row.key]) : false}
            disabled={!row.key}
            onCheckedChange={(checked) => {
              if (!row.key) return;
              // 闭包内 `row.key` 的窄化不保留（回调可延迟到 row 已变），
              // 先提到不可变局部再进 setDirty 的 computed key。
              const key = row.key;
              setDirty((current) => ({...current, [key]: checked}));
              setSaved(false);
              setSaveError(null);
            }}
          />
          <span>{t(row.labelKey)}</span>
        </label>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("appLoginMethods.loginTitle")}</CardTitle>
          <CardDescription>{t("appLoginMethods.intro")}</CardDescription>
        </CardHeader>
        <CardContent>{renderRows(LOGIN_ROWS)}</CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("appLoginMethods.registerTitle")}</CardTitle>
          <CardDescription>{t("appLoginMethods.registerIntro")}</CardDescription>
        </CardHeader>
        <CardContent>{renderRows(REGISTER_ROWS)}</CardContent>
      </Card>
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
        {config.updatedAtMs > 0
          ? formatAdminDateTime(config.updatedAtMs)
          : t("appLoginMethods.neverSaved")}
      </p>
    </div>
  );
}
