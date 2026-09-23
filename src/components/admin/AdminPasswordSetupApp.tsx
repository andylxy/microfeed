import {type FormEvent, useState} from "react";
import {LoaderCircleIcon} from "lucide-react";

import {useTranslation} from "@/client/i18n";
import {authClient} from "@/client/auth-client";
import {Button} from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {Input} from "@/components/ui/input";
import {
  adminBasePath,
  adminUrl,
  browserAdminPath,
} from "@/shared/AdminPath";
import {MIN_ADMIN_PASSWORD_LENGTH} from "@/shared/AdminCredentials";

interface Props {
  email: string;
  purpose: "initial" | "reset";
}

interface CompletionResponse {
  email?: string;
  error?: string;
}

export default function AdminPasswordSetupApp({email, purpose}: Props) {
  const {t} = useTranslation();
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const isReset = purpose === "reset";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const response = await fetch(
        adminUrl("login/set_password/complete", browserAdminPath()),
        {
          body: JSON.stringify({password, passwordConfirmation}),
          headers: {"content-type": "application/json"},
          method: "POST",
        },
      );
      const result = await response.json() as CompletionResponse;
      if (!response.ok) {
        setError(result.error ?? t("passwordSetup.saveFailed"));
        return;
      }

      const signIn = await authClient.signIn.email({
        email: result.email ?? email,
        password,
        rememberMe: true,
      });
      if (signIn.error) {
        window.location.assign(adminUrl("login", browserAdminPath()));
        return;
      }
      window.location.assign(adminBasePath(browserAdminPath()));
    } catch {
      setError(t("passwordSetup.saveUnavailable"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-svh bg-admin-canvas px-5 py-12 text-foreground">
      <div className="mx-auto flex w-full max-w-lg flex-col justify-center">
        <div className="mb-8 flex items-center justify-center gap-3">
          <img
            alt=""
            aria-hidden="true"
            className="size-11"
            src="/assets/favicon/android-chrome-192x192.png"
          />
          <span className="text-2xl font-bold tracking-tight">microfeed</span>
        </div>

        <Card className="gap-0 overflow-visible py-0">
          <CardHeader className="gap-2 px-7 pt-7 pb-6 sm:px-9 sm:pt-9">
            <CardTitle>
              <h1 className="text-2xl leading-tight font-semibold tracking-[-0.025em] sm:text-[1.75rem]">
                {isReset ? t("passwordSetup.resetTitle") : t("passwordSetup.createTitle")}
              </h1>
            </CardTitle>
            <p className="text-sm leading-6 text-muted-foreground">
              {isReset
                ? t("passwordSetup.resetDescription")
                : t("passwordSetup.createDescription")}
            </p>
          </CardHeader>

          <CardContent className="px-7 pb-7 sm:px-9 sm:pb-9">
            <form onSubmit={submit}>
              <FieldGroup className="gap-5">
                <Field>
                  <FieldLabel htmlFor="microfeed-setup-email">{t("passwordSetup.email")}</FieldLabel>
                  <Input
                    className="h-11 bg-muted/40 px-3 text-base md:text-base"
                    id="microfeed-setup-email"
                    readOnly
                    type="email"
                    value={email}
                  />
                </Field>

                <Field data-invalid={Boolean(error)}>
                  <FieldLabel htmlFor="microfeed-setup-password">
                    {t("passwordSetup.password")}
                  </FieldLabel>
                  <Input
                    aria-invalid={Boolean(error)}
                    autoComplete="new-password"
                    autoFocus
                    className="h-11 px-3 text-base md:text-base"
                    id="microfeed-setup-password"
                    maxLength={128}
                    minLength={MIN_ADMIN_PASSWORD_LENGTH}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    type="password"
                    value={password}
                  />
                  <FieldDescription>{t("passwordSetup.passwordDescription")}</FieldDescription>
                </Field>

                <Field data-invalid={Boolean(error)}>
                  <FieldLabel htmlFor="microfeed-setup-password-confirmation">
                    {t("passwordSetup.confirmPassword")}
                  </FieldLabel>
                  <Input
                    aria-invalid={Boolean(error)}
                    autoComplete="new-password"
                    className="h-11 px-3 text-base md:text-base"
                    id="microfeed-setup-password-confirmation"
                    maxLength={128}
                    minLength={MIN_ADMIN_PASSWORD_LENGTH}
                    onChange={(event) =>
                      setPasswordConfirmation(event.target.value)
                    }
                    required
                    type="password"
                    value={passwordConfirmation}
                  />
                </Field>

                {error && (
                  <FieldError
                    aria-live="polite"
                    className="rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2.5"
                  >
                    {error}
                  </FieldError>
                )}

                <Button
                  className="h-11 w-full text-base font-medium"
                  disabled={submitting}
                  size="lg"
                  type="submit"
                >
                  {submitting && (
                    <LoaderCircleIcon
                      aria-hidden="true"
                      className="animate-spin"
                      data-icon="inline-start"
                    />
                  )}
                  {submitting
                    ? t("passwordSetup.saving")
                    : isReset
                      ? t("passwordSetup.resetPassword")
                      : t("passwordSetup.createPassword")}
                </Button>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
