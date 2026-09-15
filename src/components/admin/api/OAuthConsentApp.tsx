import {AlertTriangleIcon, CheckIcon, XIcon} from "lucide-react";
import {useState} from "react";

import {authClient} from "@/client/auth-client";
import {Button} from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {useTranslation} from "@/client/i18n";
import {
  OAUTH_SCOPE_DESCRIPTIONS,
  OAUTH_SCOPES,
  type OAuthClientSummary,
} from "@/shared/OAuth";

interface Props {
  client: OAuthClientSummary;
  connectionName?: string;
  instanceName: string;
  instanceOrigin: string;
  requestedScopes: string[];
}

export default function OAuthConsentApp({
  client,
  connectionName,
  instanceName,
  instanceOrigin,
  requestedScopes,
}: Props) {
  const {t} = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const decide = async (accept: boolean) => {
    setSubmitting(true);
    setError("");
    try {
      const result = await authClient.oauth2.consent({accept});
      if (result.error || !result.data?.url) {
        setError(result.error?.message ?? t("api.oauthError"));
        return;
      }
      window.location.assign(result.data.url);
    } catch {
      setError(t("api.oauthErrorRetry"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-svh bg-admin-canvas px-5 py-12 text-foreground">
      <div className="mx-auto flex w-full max-w-xl flex-col justify-center">
        <div className="mb-8 flex items-center justify-center gap-3">
          <img alt="" aria-hidden="true" className="size-11" src="/assets/favicon/android-chrome-192x192.png" />
          <span className="text-2xl font-bold tracking-tight">microfeed</span>
        </div>
        <Card className="gap-0 overflow-visible py-0">
          <CardHeader className="border-b px-7 pt-7 pb-6 sm:px-9 sm:pt-9">
            <CardTitle>
              <h1 className="text-2xl leading-tight font-semibold tracking-[-0.025em]">
                {t("api.oauthAllow", {client: client.name})}
              </h1>
            </CardTitle>
            <CardDescription className="mt-2">
              <strong className="text-foreground">{instanceName}</strong>
              <span className="block break-all">{instanceOrigin}</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5 px-7 py-6 sm:px-9">
            {connectionName && (
              <div className="rounded-xl border bg-muted/40 p-4">
                <p className="text-sm text-muted-foreground">{t("api.oauthComputerConnection")}</p>
                <p className="mt-1 font-medium">{connectionName}</p>
              </div>
            )}
            <div>
              <h2 className="font-medium">{t("api.oauthRequestedPermissions")}</h2>
              <ul className="mt-3 grid gap-3">
                {requestedScopes.map((scope) => (
                  <li className="flex items-start gap-3" key={scope}>
                    <CheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                    <div>
                      <p className="font-medium">{OAUTH_SCOPE_DESCRIPTIONS[scope] ?? scope}</p>
                      <code className="text-xs text-muted-foreground">{scope}</code>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            {requestedScopes.includes(OAUTH_SCOPES.WRITE) && (
              <div className="flex gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
                <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-amber-700 dark:text-amber-400" />
                <p>{t("api.oauthWriteAccessNote")}</p>
              </div>
            )}
            <p className="text-sm text-muted-foreground">
              {t("api.oauthPasswordNote")}
            </p>
            {error && <p aria-live="polite" className="text-sm text-destructive">{error}</p>}
          </CardContent>
          <CardFooter className="justify-end gap-3 px-7 py-5 sm:px-9">
            <Button disabled={submitting} onClick={() => void decide(false)} type="button" variant="outline">
              <XIcon aria-hidden="true" /> {t("api.oauthDeny")}
            </Button>
            <Button disabled={submitting} onClick={() => void decide(true)} type="button">
              <CheckIcon aria-hidden="true" /> {submitting ? t("api.oauthAuthorizing") : t("api.oauthAllowButton")}
            </Button>
          </CardFooter>
        </Card>
      </div>
    </main>
  );
}
