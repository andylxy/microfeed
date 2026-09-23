import {type FormEvent, useRef, useState} from "react";
import {LoaderCircleIcon} from "lucide-react";

import {MAX_ADMIN_PASSWORD_LENGTH, adminAccountKind} from "@/shared/AdminCredentials";
import {
  adminBasePath,
  browserAdminPath,
} from "@/shared/AdminPath";
import {ADMIN_URLS} from "@/shared/StringUtils";
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
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {Input} from "@/components/ui/input";

function safeRedirect(): string {
  const fallback = adminBasePath(browserAdminPath());
  const requested = new URLSearchParams(window.location.search).get("redirect");
  if (!requested) {
    return fallback;
  }
  const candidate = new URL(requested, window.location.origin);
  return candidate.origin === window.location.origin &&
      candidate.pathname.startsWith(fallback)
    ? `${candidate.pathname}${candidate.search}${candidate.hash}`
    : fallback;
}

function safeAuthorizationRedirect(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const adminBase = adminBasePath(browserAdminPath());
  const candidate = new URL(value, window.location.origin);
  return candidate.origin === window.location.origin &&
      candidate.pathname.startsWith(adminBase)
    ? `${candidate.pathname}${candidate.search}${candidate.hash}`
    : null;
}

/**
 * The dashboard sign-in card, laid out in three fixed bands:
 *
 *   top     the tabs (account / login credential) — never moves
 *   middle  the fields only: email + password, or the credential token
 *   bottom  the shared submit button both tabs submit through
 *
 * Passkey sign-in is deliberately not offered here — passkeys are still
 * registered and revoked on the account page, but this card signs in with a
 * password or a login credential only.
 *
 * Switching a tab swaps the middle band alone, so the tabs above and the submit
 * button below stay exactly where they are. One `<form>` covers all three bands
 * because the submit button is shared by both tabs; the inactive field set is a
 * `disabled` fieldset, which keeps it out of constraint validation and out of
 * submission (a hidden-but-`required` input would silently block the submit),
 * and it shares the active set's grid cell so the band height is the taller of
 * the two and never changes.
 */
export default function AdminLoginApp() {
  const {t} = useTranslation();
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [credential, setCredential] = useState("");
  const [credentialError, setCredentialError] = useState("");
  const [credentialSubmitting, setCredentialSubmitting] = useState(false);
  const [mode, setMode] = useState<"account" | "credential">("account");
  const accountInputRef = useRef<HTMLInputElement>(null);
  const credentialInputRef = useRef<HTMLInputElement>(null);

  const isAccount = mode === "account";
  // Each tab owns its error, so a failed attempt on one does not follow the
  // visitor to the other; the bottom band shows whichever belongs to the tab in
  // front.
  const activeError = isAccount ? error : credentialError;
  const busy = isAccount ? submitting : credentialSubmitting;

  // Both field sets stay mounted (see the layout note above), so the focus move
  // has to be explicit — and must not scroll the page, or a short viewport would
  // jump on every switch.
  function selectMode(next: "account" | "credential") {
    setMode(next);
    setError("");
    setCredentialError("");
    const target = next === "account" ? accountInputRef : credentialInputRef;
    target.current?.focus({preventScroll: true});
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (isAccount) {
      void submitAccount(event);
    } else {
      void signInWithCredential(event);
    }
  }

  async function submitAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      // The field takes an address or a username, so the identifier decides
      // which endpoint signs in. Anything with an `@` is treated as an address.
      const result = adminAccountKind(account) === "email"
        ? await authClient.signIn.email({
          email: account.trim(),
          password,
          rememberMe: true,
        })
        : await authClient.signIn.username({
          password,
          rememberMe: true,
          username: account.trim(),
        });
      if (result.error) {
        setError(t("login.incorrectCredentials"));
        return;
      }
      const response = result.data as {url?: unknown} | null;
      window.location.assign(
        safeAuthorizationRedirect(response?.url) ?? safeRedirect(),
      );
    } catch {
      setError(t("login.signInUnavailable"));
    } finally {
      setSubmitting(false);
    }
  }

  async function signInWithCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCredentialError("");
    setCredentialSubmitting(true);
    try {
      // The endpoint sets the better-auth session cookie on success; the client
      // then navigates into the dashboard exactly like the other sign-in paths.
      const response = await fetch(ADMIN_URLS.ajaxCredentialLogin(), {
        body: JSON.stringify({token: credential.trim()}),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as {
          error?: string;
        };
        setCredentialError(data.error || t("login.credentialInvalid"));
        return;
      }
      window.location.assign(safeRedirect());
    } catch {
      setCredentialError(t("login.credentialUnavailable"));
    } finally {
      setCredentialSubmitting(false);
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
          <CardHeader className="gap-0 px-7 pt-7 pb-6 sm:px-9 sm:pt-9">
            <CardTitle>
              <h1 className="text-2xl leading-tight font-semibold tracking-[-0.025em] sm:text-[1.75rem]">
                {t("login.signInTitle")}
              </h1>
            </CardTitle>
          </CardHeader>

          <CardContent className="px-7 pb-7 sm:px-9 sm:pb-9">
            {/* Top band — the tabs. */}
            <div
              aria-label={t("login.tabsAria")}
              className="mb-6 flex gap-2"
              role="tablist"
            >
              <Button
                aria-selected={isAccount}
                className="flex-1"
                onClick={() => selectMode("account")}
                role="tab"
                size="sm"
                type="button"
                variant={isAccount ? "default" : "outline"}
              >
                {t("login.tabAccount")}
              </Button>
              <Button
                aria-selected={!isAccount}
                className="flex-1"
                onClick={() => selectMode("credential")}
                role="tab"
                size="sm"
                type="button"
                variant={isAccount ? "outline" : "default"}
              >
                {t("login.tabCredential")}
              </Button>
            </div>

            <form onSubmit={handleSubmit}>
              {/* Middle band — the only part that swaps. */}
              <div className="grid">
                <fieldset
                  className={`col-start-1 row-start-1 m-0 min-w-0 border-0 p-0${
                    isAccount ? "" : " invisible"
                  }`}
                  disabled={!isAccount}
                >
                  <FieldGroup className="gap-5">
                    <Field data-invalid={Boolean(error)}>
                      <FieldLabel htmlFor="microfeed-login-account">
                        {t("login.account")}
                      </FieldLabel>
                      <Input
                        aria-invalid={Boolean(error)}
                        autoComplete="username"
                        autoFocus
                        className="h-11 px-3 text-base md:text-base"
                        id="microfeed-login-account"
                        onChange={(event) => setAccount(event.target.value)}
                        placeholder={t("login.accountPlaceholder")}
                        ref={accountInputRef}
                        required
                        type="text"
                        value={account}
                      />
                    </Field>

                    <Field data-invalid={Boolean(error)}>
                      <FieldLabel htmlFor="microfeed-login-password">
                        {t("login.password")}
                      </FieldLabel>
                      <Input
                        aria-invalid={Boolean(error)}
                        autoComplete="current-password"
                        className="h-11 px-3 text-base md:text-base"
                        id="microfeed-login-password"
                        maxLength={MAX_ADMIN_PASSWORD_LENGTH}
                        onChange={(event) => setPassword(event.target.value)}
                        placeholder={t("login.passwordPlaceholder")}
                        required
                        type="password"
                        value={password}
                      />
                    </Field>
                  </FieldGroup>
                </fieldset>

                <fieldset
                  className={`col-start-1 row-start-1 m-0 min-w-0 border-0 p-0${
                    isAccount ? " invisible" : ""
                  }`}
                  disabled={isAccount}
                >
                  <FieldGroup className="gap-5">
                    <Field data-invalid={Boolean(credentialError)}>
                      <FieldLabel htmlFor="microfeed-login-credential">
                        {t("login.credentialLabel")}
                      </FieldLabel>
                      <Input
                        aria-invalid={Boolean(credentialError)}
                        autoComplete="off"
                        className="h-11 px-3 font-mono text-sm md:text-sm"
                        id="microfeed-login-credential"
                        onChange={(event) => setCredential(event.target.value)}
                        placeholder={t("login.credentialPlaceholder")}
                        ref={credentialInputRef}
                        required
                        type="text"
                        value={credential}
                      />
                    </Field>
                  </FieldGroup>
                </fieldset>
              </div>

              {/* Bottom band — identical in both tabs, including the shared
                  submit button the tabs have in common. */}
              <FieldGroup className="mt-5 gap-5">
                {activeError && (
                  <FieldError
                    aria-live="polite"
                    className="rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2.5"
                  >
                    {activeError}
                  </FieldError>
                )}

                <Button
                  className="h-11 w-full text-base font-medium"
                  disabled={busy}
                  size="lg"
                  type="submit"
                >
                  {busy && (
                    <LoaderCircleIcon
                      aria-hidden="true"
                      className="animate-spin"
                      data-icon="inline-start"
                    />
                  )}
                  {busy ? t("login.signingIn") : t("login.signIn")}
                </Button>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
