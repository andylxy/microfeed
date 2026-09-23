import {
  CheckCircle2Icon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  IdCardIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  XCircleIcon,
} from "lucide-react";
import {useState} from "react";

import {formatAdminDate} from "@/client/admin-date-format";
import {Button} from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {showToast} from "@/client/ToastUtils";
import i18n, {useTranslation} from "@/client/i18n";
import {
  MAX_API_CREDENTIALS_PER_USER,
  type ApiAccessSettings,
  type ApiKeyRecord,
} from "@/shared/Api";
import {ADMIN_URLS} from "@/shared/StringUtils";
import {signRequest} from "@/shared/api-signing";

// `/api/ping` is a literal, same-origin path handled by the middleware before the
// versioned integration API, so the client signs it with path "/api/ping".
const PING_PATH = "/api/ping";

interface Props {
  initialCredentials: ApiKeyRecord[];
  initialSettings: ApiAccessSettings;
  userId: string;
}

interface PendingSecret {
  id: string;
  accessKey: string;
  secret: string;
}

interface SignatureTest {
  id: string;
  ok: boolean;
  message: string;
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & {error?: string};
  if (!response.ok) {
    throw new Error(body.error ?? i18n.t("api.requestFailed"));
  }
  return body;
}

function maskedAccessKey(accessKey: string): string {
  return `${accessKey.slice(0, 3)}${"•".repeat(18)}${accessKey.slice(-6)}`;
}

export default function ApiCredentialsApp({
  initialCredentials,
  initialSettings,
  userId,
}: Props) {
  const {t} = useTranslation();
  const [credentials, setCredentials] = useState(initialCredentials);
  const [settings, setSettings] = useState(initialSettings);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [pendingSecret, setPendingSecret] = useState<PendingSecret | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [signatureTest, setSignatureTest] = useState<SignatureTest | null>(null);

  const atLimit = credentials.length >= MAX_API_CREDENTIALS_PER_USER;

  const openCreate = () => {
    setName("");
    setCreateOpen(true);
  };

  const create = async () => {
    if (!settings.enabled) return;
    setSaving(true);
    try {
      const result = await responseJson<{
        apiKey: ApiKeyRecord;
        settings: ApiAccessSettings;
      }>(await fetch(ADMIN_URLS.ajaxApiCredentials(), {
        body: JSON.stringify({name}),
        headers: {"content-type": "application/json"},
        method: "POST",
      }));
      setCredentials((current) => [result.apiKey, ...current]);
      setSettings(result.settings);
      setCreateOpen(false);
      // The plaintext secret is returned exactly once — surface it immediately.
      if (result.apiKey.secret) {
        setPendingSecret({
          id: result.apiKey.id,
          accessKey: result.apiKey.apiKey,
          secret: result.apiKey.secret,
        });
      }
      showToast(t("api.credentialCreated"), "success");
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : t("api.credentialCreateFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const replaceCredential = (next: ApiKeyRecord) => {
    setCredentials((current) => current.map((entry) =>
      entry.id === next.id ? next : entry
    ));
  };

  const rename = async (credential: ApiKeyRecord) => {
    const nextName = window.prompt(t("api.nameThisApiKey"), credential.name)?.trim();
    if (!nextName || nextName === credential.name) return;
    try {
      const result = await responseJson<{apiKey: ApiKeyRecord}>(
        await fetch(ADMIN_URLS.ajaxApiCredential(credential.id), {
          body: JSON.stringify({name: nextName}),
          headers: {"content-type": "application/json"},
          method: "PATCH",
        }),
      );
      replaceCredential(result.apiKey);
      showToast(t("api.keyRenamed"), "success");
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : t("api.keyRenameFailed"),
        "error",
      );
    }
  };

  const rotate = async (credential: ApiKeyRecord) => {
    if (!window.confirm(t("api.rotateConfirm", {name: credential.name}))) return;
    try {
      const result = await responseJson<{apiKey: ApiKeyRecord}>(
        await fetch(ADMIN_URLS.ajaxRotateApiCredential(credential.id), {
          method: "POST",
        }),
      );
      replaceCredential(result.apiKey);
      // A rotation returns a fresh plaintext secret exactly once.
      if (result.apiKey.secret) {
        setPendingSecret({
          id: result.apiKey.id,
          accessKey: result.apiKey.apiKey,
          secret: result.apiKey.secret,
        });
      }
      showToast(t("api.credentialRotated"), "success");
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : t("api.credentialRotateFailed"),
        "error",
      );
    }
  };

  const revoke = async (credential: ApiKeyRecord) => {
    if (!window.confirm(t("api.revokeConfirm", {name: credential.name}))) return;
    try {
      await responseJson<Record<string, never>>(
        await fetch(ADMIN_URLS.ajaxApiCredential(credential.id), {
          method: "DELETE",
        }),
      );
      setCredentials((current) => current.filter(({id}) => id !== credential.id));
      showToast(t("api.credentialRevoked"), "success");
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : t("api.credentialRevokeFailed"),
        "error",
      );
    }
  };

  const copy = async (text: string, toastKey: string) => {
    await navigator.clipboard.writeText(text);
    showToast(t(toastKey), "success");
  };

  const testSignature = async () => {
    if (!pendingSecret) return;
    setTestingId(pendingSecret.id);
    setSignatureTest(null);
    try {
      const headers = await signRequest({
        accessKey: pendingSecret.accessKey,
        method: "GET",
        path: PING_PATH,
        secret: pendingSecret.secret,
      });
      const response = await fetch(PING_PATH, {headers});
      if (response.ok) {
        const data = await response.json().catch(() => ({})) as {
          ownerUserId?: string;
        };
        const linked = data.ownerUserId === userId;
        setSignatureTest({
          id: pendingSecret.id,
          message: t("api.signatureTestOk"),
          ok: linked,
        });
        if (!linked) {
          setSignatureTest({
            id: pendingSecret.id,
            message: t("api.signatureTestFailed", {reason: "owner_mismatch"}),
            ok: false,
          });
        }
      } else {
        const reason = response.status === 401
          ? "bad_signature"
          : `http_${response.status}`;
        setSignatureTest({
          id: pendingSecret.id,
          message: t("api.signatureTestFailed", {reason}),
          ok: false,
        });
      }
    } catch (error) {
      setSignatureTest({
        id: pendingSecret.id,
        message: t("api.signatureTestFailed", {
          reason: error instanceof Error ? error.message : "network",
        }),
        ok: false,
      });
    } finally {
      setTestingId(null);
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="border-b">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <CardTitle>{t("api.credentialsTitle")}</CardTitle>
              <CardDescription className="mt-1">
                {t("api.credentialsDescription")}
              </CardDescription>
            </div>
            <Button
              disabled={atLimit || !settings.enabled}
              onClick={openCreate}
              title={atLimit ? t("errors.apiCredential.limitReached", {
                count: String(MAX_API_CREDENTIALS_PER_USER),
              }) : undefined}
              type="button"
            >
              <PlusIcon aria-hidden="true" />
              {t("api.generateCredential")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {credentials.length ? (
            <ul className="divide-y">
              {credentials.map((credential) => {
                const visible = revealed.has(credential.id);
                return (
                  <li
                    className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
                    key={credential.id}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <IdCardIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                        <h2 className="truncate font-medium">{credential.name}</h2>
                      </div>
                      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
                        <code className="max-w-full overflow-x-auto rounded-md bg-muted px-2 py-1 text-xs">
                          {visible
                            ? credential.apiKey
                            : maskedAccessKey(credential.apiKey)}
                        </code>
                        <Button
                          aria-label={visible
                            ? t("api.hideApiKey")
                            : t("api.revealApiKey")}
                          onClick={() => setRevealed((current) => {
                            const next = new Set(current);
                            if (next.has(credential.id)) next.delete(credential.id);
                            else next.add(credential.id);
                            return next;
                          })}
                          size="icon-sm"
                          type="button"
                          variant="ghost"
                        >
                          {visible ? <EyeOffIcon /> : <EyeIcon />}
                        </Button>
                        <Button
                          aria-label={t("api.copyApiKey")}
                          onClick={() => copy(credential.apiKey, "api.keyCopied")}
                          size="icon-sm"
                          type="button"
                          variant="ghost"
                        >
                          <CopyIcon />
                        </Button>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {t("api.created")} {formatAdminDate(credential.createdAtMs)}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        onClick={() => rename(credential)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        <PencilIcon />
                        {t("api.rename")}
                      </Button>
                      <Button
                        onClick={() => rotate(credential)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        <RefreshCwIcon />
                        {t("api.rotate")}
                      </Button>
                      <Button
                        className="text-destructive hover:text-destructive"
                        onClick={() => revoke(credential)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        <Trash2Icon />
                        {t("api.revoke")}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="p-10 text-center">
              <IdCardIcon aria-hidden="true" className="mx-auto size-8 text-muted-foreground" />
              <p className="mt-3 font-medium">{t("api.noCredentialsYet")}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("api.noCredentialsYetDescription")}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!saving) setCreateOpen(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("api.generateCredential")}</DialogTitle>
            <DialogDescription>
              {t("api.generateCredentialDescription")}
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label htmlFor="api-credential-name">{t("api.name")}</Label>
            <Input
              aria-describedby="api-credential-name-examples"
              autoFocus
              className="mt-2"
              id="api-credential-name"
              maxLength={80}
              placeholder={t("api.credentialNamePlaceholder")}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              disabled={saving}
              onClick={() => setCreateOpen(false)}
              type="button"
              variant="outline"
            >
              {t("api.cancel")}
            </Button>
            <Button
              disabled={saving || !settings.enabled || !name.trim()}
              onClick={create}
              type="button"
            >
              {t("api.generateCredential")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* One-time secret reveal for a freshly created or rotated credential. */}
      <Dialog
        open={pendingSecret !== null}
        onOpenChange={(open) => {
          if (!open) setPendingSecret(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("api.secretLabel")}</DialogTitle>
            <DialogDescription>
              {t("api.secretShownOnce")}
            </DialogDescription>
          </DialogHeader>
          {pendingSecret && (
            <div className="grid gap-4">
              <div>
                <Label className="text-xs text-muted-foreground">
                  {t("api.copyApiKey")}
                </Label>
                <div className="mt-1 flex items-center gap-2">
                  <code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-muted px-2 py-1 text-xs">
                    {pendingSecret.accessKey}
                  </code>
                  <Button
                    aria-label={t("api.copyApiKey")}
                    onClick={() => copy(pendingSecret.accessKey, "api.keyCopied")}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <CopyIcon />
                  </Button>
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">
                  {t("api.secretLabel")}
                </Label>
                <div className="mt-1 flex items-center gap-2">
                  <code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-muted px-2 py-1 text-xs">
                    {pendingSecret.secret}
                  </code>
                  <Button
                    aria-label={t("api.copySecret")}
                    onClick={() => copy(pendingSecret.secret, "api.secretCopied")}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <CopyIcon />
                  </Button>
                </div>
              </div>
              <div className="rounded-lg border bg-muted/30 p-3">
                <Button
                  disabled={testingId === pendingSecret.id}
                  onClick={testSignature}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {testingId === pendingSecret.id
                    ? <Loader2Icon className="animate-spin" />
                    : <CheckCircle2Icon />}
                  {t("api.testSignature")}
                </Button>
                {signatureTest && signatureTest.id === pendingSecret.id && (
                  <p
                    className={[
                      "mt-2 flex items-center gap-2 text-sm",
                      signatureTest.ok
                        ? "text-emerald-600"
                        : "text-destructive",
                    ].join(" ")}
                  >
                    {signatureTest.ok
                      ? <CheckCircle2Icon className="size-4" />
                      : <XCircleIcon className="size-4" />}
                    {signatureTest.message}
                  </p>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setPendingSecret(null)} type="button">
              {t("api.cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
