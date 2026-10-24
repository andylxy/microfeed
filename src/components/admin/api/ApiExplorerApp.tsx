import {useState} from "react";

import ApiReference from "@/components/api/ApiReference";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {useTranslation} from "@/client/i18n";
import type {ApiAccessSettings, ApiKeyRecord} from "@/shared/Api";

interface Props {
  authenticationUrl: string;
  document: Record<string, unknown>;
  initialApiKeys: ApiKeyRecord[];
  origin: string;
  settings: ApiAccessSettings;
  settingsUrl: string;
}

export default function ApiExplorerApp({
  authenticationUrl,
  document,
  initialApiKeys,
  origin,
  settings,
  settingsUrl,
}: Props) {
  const {t} = useTranslation();
  // 库里只存哈希（ADR-0047 D3），密钥列表没有明文可用——令牌由使用者在
  // 创建/轮换后自行保存并粘贴到这里，仅在页面内存中使用。
  const [token, setToken] = useState("");
  const effectiveToken = token.trim();
  const disabled = !settings.enabled || !effectiveToken;

  return (
    <div className="grid gap-4">
      <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="w-full max-w-sm">
          <Label htmlFor="api-key-token">{t("api.keyForTestRequests")}</Label>
          <Input
            autoComplete="off"
            className="mt-2"
            id="api-key-token"
            onChange={(event) => setToken(event.target.value)}
            placeholder="mf_…"
            type="password"
            value={token}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            {t("api.pasteApiKeyHint")}
          </p>
        </div>
        {!settings.enabled ? (
          <p className="text-sm text-muted-foreground">
            {t("api.apiAccessDisabled")}{" "}
            <a className="underline" href={settingsUrl}>{t("api.enableInSettings")}</a>{" "}
            {t("api.toSendRequests")}
          </p>
        ) : !initialApiKeys.length ? (
          <Button render={<a href={authenticationUrl} />}>{t("api.createAnApiKey")}</Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("api.keyStaysInMemory")}
          </p>
        )}
      </div>
      <div className="overflow-hidden rounded-xl border bg-background">
        <ApiReference
          key={settings.enabled}
          apiKey={effectiveToken || undefined}
          document={document}
          followDocumentColorMode
          origin={origin}
          pinSidebarFooterToPageBottom
          requestsDisabled={disabled}
        />
      </div>
    </div>
  );
}
