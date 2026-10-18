import {useCallback, useEffect, useState} from "react";

import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {formatAdminDateTime} from "@/client/admin-date-format";
import {useTranslation} from "@/client/i18n";
import Requests from "@/client/requests";
import {showToast} from "@/client/ToastUtils";
import {ADMIN_URLS} from "@/shared/StringUtils";
import SettingsBase from "../SettingsBase";

/** Cloudflare 控制台的 API Token 页面（外部入口，只用于给管理员指路）。 */
const CLOUDFLARE_TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

interface TokenStatus {
  configured: boolean;
  tokenHint: string;
  updatedAtMs: number | null;
}

interface StatusResponse {
  ok?: boolean;
  data?: TokenStatus;
  error?: string;
}

/** 从 axios 错误里取出服务端已经本地化好的文案，取不到时用兜底键。 */
function errorMessage(error: unknown, fallback: string): string {
  const response = (error as {response?: {data?: {error?: string}}})?.response;
  return response?.data?.error || fallback;
}

/**
 * 站点设置 → Cloudflare API Token。
 *
 * 即时保存：这个分区自带请求与 toast，不走 `SettingsApp.onSubmit` 的通用保存路径。
 * 理由在数据侧——Token 必须在服务端加密之后才允许写库，而通用路径把客户端 JSON
 * 原样 upsert 进 settings 表，没有加密的介入点（见 `src/server/cloud-usage/token-store.ts`）。
 *
 * 界面只显示末四位与更新时刻；密文与明文都不进入这个组件。
 */
export default function CloudflareTokenSettingsApp() {
  const {t} = useTranslation();
  const [status, setStatus] = useState<TokenStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await Requests.axiosGet(ADMIN_URLS.ajaxCloudUsageToken());
      const payload = response.data as StatusResponse;
      setStatus(payload.data ?? null);
      setLoadFailed(!payload.ok);
    } catch (error) {
      setLoadFailed(true);
      showToast(
        errorMessage(error, t("settings.cloudflareTokenLoadFailed")),
        "error",
      );
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    try {
      const response = await Requests.axiosPost(ADMIN_URLS.ajaxCloudUsageToken(), {
        token: draft,
      });
      const payload = response.data as StatusResponse;
      if (!payload.ok) {
        showToast(payload.error || t("settings.cloudflareTokenSaveFailed"), "error");
        return;
      }
      setStatus(payload.data ?? null);
      setDraft("");
      showToast(t("settings.cloudflareTokenSaved"), "success");
    } catch (error) {
      showToast(
        errorMessage(error, t("settings.cloudflareTokenSaveFailed")),
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      const response = await Requests.axiosDelete(ADMIN_URLS.ajaxCloudUsageToken());
      const payload = response.data as StatusResponse;
      if (!payload.ok) {
        showToast(payload.error || t("settings.cloudflareTokenSaveFailed"), "error");
        return;
      }
      setStatus(payload.data ?? null);
      setDraft("");
      showToast(t("settings.cloudflareTokenCleared"), "success");
    } catch (error) {
      showToast(
        errorMessage(error, t("settings.cloudflareTokenSaveFailed")),
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  const statusLine = loadFailed
    ? t("settings.cloudflareTokenLoadFailed")
    : status?.configured
      ? t("settings.cloudflareTokenConfigured", {
        hint: status.tokenHint,
        time: status.updatedAtMs ? formatAdminDateTime(status.updatedAtMs) : "—",
      })
      : t("settings.cloudflareTokenNotConfigured");

  return (<SettingsBase
    currentType="cloudflare-token"
    description={t("settings.cloudflareTokenDescription")}
    title={t("settings.cloudflareToken")}
  >
    <div className="grid gap-4">
      <p aria-live="polite" className="text-sm text-muted-foreground">
        {statusLine}
      </p>
      <div className="grid gap-2">
        <label className="text-sm font-medium" htmlFor="cloudflare-token-input">
          {t("settings.cloudflareTokenInputLabel")}
        </label>
        <Input
          autoComplete="off"
          id="cloudflare-token-input"
          placeholder={t("settings.cloudflareTokenPlaceholder")}
          type="password"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || draft.trim() === ""} onClick={save} type="button">
          {busy ? t("settings.cloudflareTokenSaving") : t("settings.cloudflareTokenSave")}
        </Button>
        <Button
          disabled={busy || !status?.configured}
          onClick={clear}
          type="button"
          variant="outline"
        >
          {t("settings.cloudflareTokenClear")}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        {t("settings.cloudflareTokenHelp")}
      </p>
      <div className="flex flex-wrap gap-4 text-sm">
        <a
          className="text-brand-dark underline underline-offset-4 hover:no-underline"
          href={CLOUDFLARE_TOKENS_URL}
          rel="noreferrer"
          target="_blank"
        >
          {t("settings.cloudflareTokenCreateLink")}
        </a>
        <a
          className="text-brand-dark underline underline-offset-4 hover:no-underline"
          href={ADMIN_URLS.cloudUsage()}
        >
          {t("settings.cloudflareTokenDashboardLink")}
        </a>
      </div>
    </div>
  </SettingsBase>);
}
