import {useCallback, useEffect, useState} from "react";

import {formatAdminDate} from "@/client/admin-date-format";
import {showToast} from "@/client/ToastUtils";
import {useTranslation} from "@/client/i18n";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import type {
  LoginCredentialBoard,
  LoginCredentialRecord,
} from "@/shared/LoginCredential";
import {ADMIN_URLS} from "@/shared/StringUtils";

interface Props {
  /**
   * Account whose credentials are managed. Omit to manage the signed-in user's
   * own credentials (the endpoint defaults `userId` to the caller).
   */
  userId?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `days: null` means "never expires"; it is also the fallback choice. */
const NEVER_EXPIRY = {
  days: null,
  id: "never",
  labelKey: "loginCredentials.noExpiry",
} as const;

/** Expiry choices offered on creation. */
const EXPIRY_CHOICES = [
  {days: 30, id: "30", labelKey: "loginCredentials.expiry30Days"},
  {days: 90, id: "90", labelKey: "loginCredentials.expiry90Days"},
  NEVER_EXPIRY,
] as const;

type ExpiryChoiceId = (typeof EXPIRY_CHOICES)[number]["id"];

async function parseError(response: Response, fallback: string): Promise<string> {
  try {
    const data = (await response.json()) as {error?: string};
    return data.error ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * List / issue / revoke login credentials for one account.
 *
 * The plaintext token is always rendered — not hidden behind a reveal — because
 * the feature is expected to be re-copied at any time; that is also why the
 * surrounding copy warns that holding the token is enough to sign in.
 */
export default function LoginCredentialsPanel({userId}: Props) {
  const {t} = useTranslation();
  const [credentials, setCredentials] = useState<LoginCredentialRecord[] | null>(
    null,
  );
  // A failed load is its own state: rendering it as an empty list would say
  // "this account has no credentials", which is a different (and wrong) claim.
  const [loadFailed, setLoadFailed] = useState(false);
  const [name, setName] = useState("");
  const [expiryId, setExpiryId] = useState<ExpiryChoiceId>("never");
  const [busy, setBusy] = useState(false);

  const listUrl = userId
    ? `${ADMIN_URLS.ajaxRbacUserCredentials()}?userId=${
      encodeURIComponent(userId)
    }`
    : ADMIN_URLS.ajaxRbacUserCredentials();
  // `userId` is included in the body only when the caller targets another
  // account; otherwise the endpoint resolves the signed-in user.
  const scope = userId ? {userId} : {};

  const load = useCallback(async () => {
    try {
      const response = await fetch(listUrl);
      if (!response.ok) throw new Error("load failed");
      const board = (await response.json()) as LoginCredentialBoard;
      setCredentials(board.credentials);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
      showToast(t("loginCredentials.loadFailed"), "error");
    }
  }, [listUrl, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const choice = EXPIRY_CHOICES.find((entry) => entry.id === expiryId) ??
      NEVER_EXPIRY;
    const expiresAtMs = choice.days === null
      ? null
      : Date.now() + choice.days * DAY_MS;
    setBusy(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxRbacUserCredentialCreate(), {
        body: JSON.stringify({...scope, expiresAtMs, name: trimmed}),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      if (!response.ok) {
        showToast(
          await parseError(response, t("loginCredentials.createFailed")),
          "error",
        );
        return;
      }
      const board = (await response.json()) as LoginCredentialBoard;
      setCredentials(board.credentials);
      setLoadFailed(false);
      setName("");
      showToast(t("loginCredentials.created"), "success");
    } catch {
      showToast(t("loginCredentials.createFailed"), "error");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (credential: LoginCredentialRecord) => {
    if (!window.confirm(t("loginCredentials.confirmRevoke", {
      name: credential.name,
    }))) {
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxRbacUserCredentialRevoke(), {
        body: JSON.stringify({...scope, credentialId: credential.id}),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      if (!response.ok) {
        showToast(
          await parseError(response, t("loginCredentials.revokeFailed")),
          "error",
        );
        return;
      }
      const board = (await response.json()) as LoginCredentialBoard;
      setCredentials(board.credentials);
      showToast(t("loginCredentials.revoked"), "success");
    } catch {
      showToast(t("loginCredentials.revokeFailed"), "error");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (secret: string) => {
    try {
      await navigator.clipboard.writeText(secret);
      showToast(t("loginCredentials.tokenCopied"), "success");
    } catch {
      // Clipboard access can be denied; the token is on screen either way.
    }
  };

  const inputId = `login-credential-name-${userId ?? "self"}`;
  const expiryInputId = `login-credential-expiry-${userId ?? "self"}`;

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor={inputId}>{t("loginCredentials.name")}</Label>
        <Input
          id={inputId}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("loginCredentials.namePlaceholder")}
          value={name}
        />
      </div>
      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor={expiryInputId}>
            {t("loginCredentials.expiryLabel")}
          </Label>
          <select
            className="h-10 w-full cursor-pointer rounded-[10px] border border-input bg-background px-3 text-sm"
            id={expiryInputId}
            onChange={(event) =>
              setExpiryId(event.target.value as ExpiryChoiceId)}
            value={expiryId}
          >
            {EXPIRY_CHOICES.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {t(choice.labelKey)}
              </option>
            ))}
          </select>
        </div>
        <Button
          disabled={busy || !name.trim()}
          onClick={() => void create()}
          type="button"
        >
          {busy ? t("loginCredentials.creating") : t("loginCredentials.create")}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        {t("loginCredentials.tokenHint")}
      </p>

      {loadFailed
        ? (
          <p className="text-sm text-destructive" role="alert">
            {t("loginCredentials.loadFailed")}
          </p>
        )
        : credentials === null
        ? null
        : credentials.length === 0
        ? (
          <p className="text-sm text-muted-foreground">
            {t("loginCredentials.empty")}
          </p>
        )
        : (
          <ul className="space-y-2">
            {credentials.map((credential) => (
              <li
                className="rounded-[10px] border px-3 py-2.5 text-sm"
                key={credential.id}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{credential.name}</span>
                  <span className="flex items-center gap-2">
                    {credential.revoked && (
                      <span className="text-xs text-muted-foreground">
                        {t("loginCredentials.revoked")}
                      </span>
                    )}
                    <Button
                      onClick={() => void copy(credential.secret)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {t("loginCredentials.copyToken")}
                    </Button>
                    {!credential.revoked && (
                      <Button
                        disabled={busy}
                        onClick={() => void revoke(credential)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        {t("loginCredentials.revoke")}
                      </Button>
                    )}
                  </span>
                </div>
                <code
                  className="mt-1.5 block truncate font-mono text-xs"
                  title={credential.secret}
                >
                  {credential.secret}
                </code>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    {credential.lastUsedAtMs
                      ? t("loginCredentials.lastUsed", {
                        date: formatAdminDate(new Date(credential.lastUsedAtMs)),
                      })
                      : t("loginCredentials.neverUsed")}
                  </span>
                  <span>
                    {credential.expiresAtMs
                      ? t("loginCredentials.expires", {
                        date: formatAdminDate(new Date(credential.expiresAtMs)),
                      })
                      : t("loginCredentials.noExpiry")}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}
