import {type FormEvent, useState} from "react";
import i18n, {useTranslation} from "@/client/i18n";
import {formatAdminDate} from "@/client/admin-date-format";
import {
  KeyRoundIcon,
  LaptopIcon,
  LoaderCircleIcon,
  MonitorSmartphoneIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UserRoundIcon,
} from "lucide-react";

import {authClient} from "@/client/auth-client";
import {showToast} from "@/client/ToastUtils";
import LoginCredentialsPanel from "@/components/admin/LoginCredentialsPanel";
import type {
  AccountPasskeySummary,
  AccountSessionSummary,
} from "@/shared/Account";
import type {OAuthApplicationAccessSummary} from "@/shared/OAuth";
import {OAUTH_SCOPE_DESCRIPTIONS} from "@/shared/OAuth";
import {adminUrl, browserAdminPath} from "@/shared/AdminPath";
import {MIN_ADMIN_PASSWORD_LENGTH} from "@/shared/AdminCredentials";
import {Button} from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
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

interface Props {
  apiEnabled: boolean;
  applications: OAuthApplicationAccessSummary[];
  builtInEmail?: string;
  cloudflareAccessDetected: boolean;
  cloudflareAccessEmail?: string;
  hostname: string;
  passkeys: AccountPasskeySummary[];
  sessions: AccountSessionSummary[];
}

interface Confirmation {
  action: "add" | "delete";
  name?: string;
  passkey?: AccountPasskeySummary;
}

type CredentialDialog = "email" | "password";

const BUILT_IN_LOGIN_GUIDE_URL =
  "https://docs.microfeed.org/manage/domains-and-access/#built-in-login";

function BuiltInLoginGuideLink() {
  return (
    <a
      className="font-medium underline underline-offset-4"
      href={BUILT_IN_LOGIN_GUIDE_URL}
      rel="noopener noreferrer"
      target="_blank"
    >
      {i18n.t("account.learnEnableBuiltIn")}
    </a>
  );
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {"content-type": "application/json", ...init.headers},
  });
  const data = await response.json().catch(() => ({})) as T & {error?: string};
  if (!response.ok) throw new Error(data.error || i18n.t("common.failed"));
  return data;
}

function dateLabel(value: string | null): string {
  if (!value) return i18n.t("account.unknown");
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? i18n.t("account.unknown") : formatAdminDate(date);
}

function deviceLabel(userAgent: string | null): string {
  if (!userAgent) return i18n.t("account.unknownBrowser");
  const browser = /Edg\//u.test(userAgent) ? "Edge"
    : /Firefox\//u.test(userAgent) ? "Firefox"
    : /Chrome\//u.test(userAgent) ? "Chrome"
    : /Safari\//u.test(userAgent) ? "Safari"
    : i18n.t("account.browserName");
  const device = /iPhone|iPad/u.test(userAgent) ? i18n.t("account.deviceIphoneOrIpad")
    : /Android/u.test(userAgent) ? "Android"
    : /Macintosh/u.test(userAgent) ? "Mac"
    : /Windows/u.test(userAgent) ? "Windows"
    : /Linux/u.test(userAgent) ? "Linux"
    : i18n.t("account.device");
  return i18n.t("account.deviceOn", {browser, device});
}

function SectionCard({children, description, icon: Icon, title}: {
  children: React.ReactNode;
  description: string;
  icon: typeof UserRoundIcon;
  title: string;
}) {
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="border-b px-5 py-5 sm:px-6">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 rounded-lg bg-muted p-2"><Icon aria-hidden="true" className="size-4" /></span>
          <div><CardTitle>{title}</CardTitle><CardDescription className="mt-1">{description}</CardDescription></div>
        </div>
      </CardHeader>
      {children}
    </Card>
  );
}

export default function AccountSettingsApp(props: Props) {
  const {t} = useTranslation();
  const [sessions, setSessions] = useState(props.sessions);
  const [applications, setApplications] = useState(props.applications);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [emailBusy, setEmailBusy] = useState(false);
  const [credentialDialog, setCredentialDialog] =
    useState<CredentialDialog | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [confirmationPassword, setConfirmationPassword] = useState("");
  const [confirmationBusy, setConfirmationBusy] = useState(false);
  const [passkeyName, setPasskeyName] = useState("");

  const accountAjax = (path: string) =>
    adminUrl(`ajax/account/${path}`, browserAdminPath());

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      await requestJson(accountAjax("password"), {
        body: JSON.stringify({
          confirmation: form.get("confirmation"),
          currentPassword: form.get("currentPassword"),
          newPassword: form.get("newPassword"),
        }),
        method: "POST",
      });
      event.currentTarget.reset();
      showToast(t("account.passwordChanged"), "success");
      window.location.reload();
    } catch (error) {
      showToast(error instanceof Error ? error.message : t("account.unableChangePassword"), "error");
    } finally {
      setPasswordBusy(false);
    }
  }

  async function changeEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEmailBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      await requestJson(accountAjax("email"), {
        body: JSON.stringify({
          currentPassword: form.get("currentPassword"),
          email: form.get("email"),
        }),
        method: "POST",
      });
      window.location.assign(`${adminUrl("login", browserAdminPath())}?email_changed=1`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t("account.unableChangeEmail"), "error");
      setEmailBusy(false);
    }
  }

  async function confirmPasskey() {
    if (!confirmation) return;
    setConfirmationBusy(true);
    try {
      await requestJson(accountAjax("passkeys/reauth"), {
        body: JSON.stringify({
          action: confirmation.action,
          passkeyId: confirmation.passkey?.id,
          password: confirmationPassword,
        }),
        method: "POST",
      });
      const result = confirmation.action === "add"
        ? await authClient.passkey.addPasskey({name: confirmation.name})
        : await authClient.passkey.deletePasskey({id: confirmation.passkey!.id});
      if (result.error) throw new Error(result.error.message || t("account.passkeyChangeFailed"));
      showToast(
        confirmation.action === "add" ? t("account.passkeyAdded") : t("account.passkeyDeleted"),
        "success",
      );
      window.location.reload();
    } catch (error) {
      showToast(error instanceof Error ? error.message : t("account.unableChangePasskeys"), "error");
      setConfirmationBusy(false);
    }
  }

  async function renamePasskey(passkey: AccountPasskeySummary) {
    const name = window.prompt(t("account.renamePasskeyPrompt"), passkey.name)?.trim();
    if (!name || name === passkey.name) return;
    if (Array.from(name).length > 64 || /[\p{Cc}\p{Cf}]/u.test(name)) {
      showToast(t("account.passkeyNameInvalid"), "error");
      return;
    }
    const result = await authClient.passkey.updatePasskey({id: passkey.id, name});
    if (result.error) {
      showToast(result.error.message || t("account.unableRenamePasskey"), "error");
      return;
    }
    showToast(t("account.passkeyRenamed"), "success");
    window.location.reload();
  }

  async function revokeSession(session: AccountSessionSummary) {
    if (!window.confirm(t("account.signOutDeviceConfirm", {device: deviceLabel(session.userAgent)}))) return;
    const response = await fetch(accountAjax(`sessions/${encodeURIComponent(session.id)}`), {method: "DELETE"});
    if (!response.ok) return showToast(t("account.unableRevokeSession"), "error");
    setSessions((current) => current.filter(({id}) => id !== session.id));
    showToast(t("account.sessionRevoked"), "success");
  }

  async function revokeOthers() {
    if (!window.confirm(t("account.revokeOthersConfirm"))) return;
    await requestJson(accountAjax("sessions/revoke-others"), {body: "{}", method: "POST"});
    setSessions((current) => current.filter(({current}) => current));
    showToast(t("account.othersRevoked"), "success");
  }

  async function revokeConnection(clientId: string, connectionId: string | null, name: string) {
    if (!window.confirm(t("account.revokeConnectionConfirm", {name}))) return;
    const id = connectionId ?? "legacy";
    const response = await fetch(accountAjax(`app-access/${encodeURIComponent(clientId)}/${encodeURIComponent(id)}`), {method: "DELETE"});
    if (!response.ok) return showToast(t("account.unableRevokeConnection"), "error");
    setApplications((current) => current.map((app) => app.clientId === clientId
      ? {...app, connections: app.connections.filter((connection) => connection.id !== connectionId)}
      : app).filter((app) => app.connections.length));
    showToast(t("account.connectionRevoked"), "success");
  }

  async function revokeApplication(clientId: string, name: string) {
    if (!window.confirm(t("account.revokeApplicationConfirm", {name}))) return;
    const response = await fetch(accountAjax(`app-access/${encodeURIComponent(clientId)}`), {method: "DELETE"});
    if (!response.ok) return showToast(t("account.unableRevokeApplication"), "error");
    setApplications((current) => current.filter((app) => app.clientId !== clientId));
    showToast(t("account.applicationRevoked"), "success");
  }

  return (
    <div className="mx-auto grid max-w-5xl gap-8">
      <section className="scroll-mt-6" id="login-identity">
        <SectionCard description={t("account.loginIdentityDescription")} icon={UserRoundIcon} title={t("account.loginIdentity")}>
          <CardContent className="grid gap-6 p-5 sm:p-6">
            {props.builtInEmail && (
              <div className="flex flex-col gap-4 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm text-muted-foreground">{t("account.builtInLogin")}</p>
                  <p className="mt-1 truncate font-medium">{props.builtInEmail}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => setCredentialDialog("password")}
                    type="button"
                  >
                    {t("account.changePassword")}
                  </Button>
                  <Button
                    onClick={() => setCredentialDialog("email")}
                    type="button"
                  >
                    {t("account.changeEmail")}
                  </Button>
                </div>
              </div>
            )}
            {props.cloudflareAccessDetected && (
              <div className="rounded-xl border p-4"><p className="text-sm text-muted-foreground">{t("account.cloudflareAccess")}</p><p className="mt-1 font-medium">{props.cloudflareAccessEmail || t("account.cloudflareAccessAuthenticated")}</p><p className="mt-1 text-sm text-muted-foreground">{t("account.cloudflareAccessManage")}</p></div>
            )}
          </CardContent>
        </SectionCard>
      </section>

      <section className="scroll-mt-6" id="passkeys">
        <SectionCard description={t("account.passkeysDescription")} icon={KeyRoundIcon} title={t("account.passkeys")}>
          <CardContent className="p-0">
            {props.builtInEmail ? (
              <>
                {props.passkeys.length ? <ul className="divide-y">{props.passkeys.map((passkey) => (
                  <li className="flex flex-wrap items-center justify-between gap-4 p-5 sm:px-6" key={passkey.id}>
                    <div><p className="font-medium">{passkey.name}</p><p className="mt-1 text-sm text-muted-foreground">{passkey.provider || passkey.deviceType || t("account.authenticator")} · {passkey.backedUp ? t("account.synced") : t("account.deviceBound")} · {t("account.added", {date: dateLabel(passkey.createdAt)})}</p></div>
                    <div className="flex gap-2"><Button onClick={() => void renamePasskey(passkey)} size="sm" type="button" variant="outline">{t("account.rename")}</Button><Button onClick={() => { setConfirmationPassword(""); setConfirmation({action: "delete", passkey}); }} size="sm" type="button" variant="destructive"><Trash2Icon aria-hidden="true" /> {t("account.delete")}</Button></div>
                  </li>
                ))}</ul> : <p className="p-6 text-sm text-muted-foreground">{t("account.noPasskeys")}</p>}
                <CardFooter className="flex-col items-start gap-3 border-t p-5 sm:px-6">
                  <div className="flex w-full flex-wrap gap-2"><Input aria-label={t("account.newPasskeyNameAria")} className="max-w-xs" maxLength={64} onChange={(event) => setPasskeyName(event.target.value)} placeholder={t("account.newPasskeyPlaceholder")} value={passkeyName} /><Button disabled={!passkeyName.trim()} onClick={() => { setConfirmationPassword(""); setConfirmation({action: "add", name: passkeyName.trim()}); }} type="button">{t("account.addPasskey")}</Button></div>
                  <p className="text-sm text-muted-foreground">{t("account.passkeysTied", {hostname: props.hostname})}</p>
                </CardFooter>
              </>
            ) : <p className="p-6 text-sm text-muted-foreground">{t("account.passkeysRequireBuiltIn")} <BuiltInLoginGuideLink /></p>}
          </CardContent>
        </SectionCard>
      </section>

      <section className="scroll-mt-6" id="login-credentials">
        <SectionCard description={t("loginCredentials.selfDescription")} icon={KeyRoundIcon} title={t("loginCredentials.title")}>
          <CardContent className="p-5 sm:p-6">
            {props.builtInEmail
              ? <LoginCredentialsPanel />
              : <p className="text-sm text-muted-foreground">{t("account.passkeysRequireBuiltIn")} <BuiltInLoginGuideLink /></p>}
          </CardContent>
        </SectionCard>
      </section>

      <section className="scroll-mt-6" id="active-sessions">
        <SectionCard description={t("account.activeSessionsDescription")} icon={MonitorSmartphoneIcon} title={t("account.activeSessions")}>
          <CardContent className="p-0">
            {props.builtInEmail && sessions.length ? <ul className="divide-y">{sessions.map((session) => (
              <li className="flex flex-wrap items-center justify-between gap-4 p-5 sm:px-6" key={session.id}>
                <div className="flex gap-3"><LaptopIcon aria-hidden="true" className="mt-1 size-5 text-muted-foreground" /><div><p className="font-medium">{deviceLabel(session.userAgent)} {session.current && <span className="ml-2 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-400">{t("account.current")}</span>}</p><p className="mt-1 text-sm text-muted-foreground">{t("account.sessionMeta", {ip: session.ipAddress || t("account.ipUnavailable"), started: dateLabel(session.createdAt), refreshed: dateLabel(session.updatedAt), expires: dateLabel(session.expiresAt)})}</p></div></div>
                {!session.current && <Button onClick={() => void revokeSession(session)} size="sm" type="button" variant="outline">{t("account.revoke")}</Button>}
              </li>
            ))}</ul> : <p className="p-6 text-sm text-muted-foreground">{props.cloudflareAccessDetected && !props.builtInEmail ? t("account.cloudflareSessionsExternal") : t("account.noActiveSessions")}</p>}
          </CardContent>
          {props.builtInEmail && sessions.some(({current}) => !current) && <CardFooter className="border-t p-5 sm:px-6"><Button onClick={() => void revokeOthers()} type="button" variant="outline">{t("account.revokeAllOtherSessions")}</Button></CardFooter>}
        </SectionCard>
      </section>

      <section className="scroll-mt-6" id="app-access">
        <SectionCard description={t("account.appAccessDescription")} icon={ShieldCheckIcon} title={t("account.appAccess")}>
          <CardContent className="p-0">
            {props.builtInEmail ? applications.length ? <div className="divide-y">{applications.map((application) => (
              <div className="p-5 sm:p-6" key={application.clientId}>
                <div className="flex flex-wrap items-start justify-between gap-4"><div><h3 className="font-semibold">{application.name}</h3><p className="mt-1 text-sm text-muted-foreground">{t(application.connections.length === 1 ? "account.connection" : "account.connections", {count: application.connections.length})}</p></div>{application.connections.length > 1 && <Button onClick={() => void revokeApplication(application.clientId, application.name)} size="sm" type="button" variant="destructive">{t("account.revokeAllConnections")}</Button>}</div>
                <ul className="mt-4 grid gap-3">{application.connections.map((connection) => {
                  const status = !props.apiEnabled && connection.active ? t("account.suspended") : connection.active ? t("account.active") : t("account.inactive");
                  return <li className="flex flex-wrap items-center justify-between gap-4 rounded-xl border p-4" key={connection.id ?? "legacy"}><div><p className="font-medium">{connection.name}</p><p className="mt-1 text-sm text-muted-foreground">{status} · {t("account.connected", {date: dateLabel(connection.connectedAt)})} · {t("account.lastUsed", {date: dateLabel(connection.lastUsedAt)})}</p><ul className="mt-2 flex flex-wrap gap-1.5">{connection.scopes.map((scope) => <li className="rounded-full bg-muted px-2 py-1 text-xs" key={scope}>{OAUTH_SCOPE_DESCRIPTIONS[scope] ?? scope}</li>)}</ul></div><Button onClick={() => void revokeConnection(application.clientId, connection.id, connection.name)} size="sm" type="button" variant="outline">{t("account.revoke")}</Button></li>;
                })}</ul>
                {application.connections.length === 1 && <Button className="mt-4" onClick={() => void revokeApplication(application.clientId, application.name)} size="sm" type="button" variant="destructive">{t("account.revokeAllConnections")}</Button>}
              </div>
            ))}</div> : <p className="p-6 text-sm text-muted-foreground">{t("account.noApplications")}</p> : <p className="p-6 text-sm text-muted-foreground">{t("account.appAccessRequiresBuiltIn")} <BuiltInLoginGuideLink /></p>}
          </CardContent>
        </SectionCard>
      </section>

      <Dialog
        open={credentialDialog === "password"}
        onOpenChange={(open) => {
          if (!open && !passwordBusy) setCredentialDialog(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <form className="grid gap-5" onSubmit={changePassword}>
            <DialogHeader>
              <DialogTitle>{t("account.changePasswordTitle")}</DialogTitle>
              <DialogDescription>
                {t("account.changePasswordDescription")}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <Label htmlFor="account-current-password">{t("account.currentPassword")}</Label>
              <Input autoComplete="current-password" autoFocus id="account-current-password" name="currentPassword" required type="password" />
              <Label htmlFor="account-new-password">{t("account.newPassword")}</Label>
              <Input autoComplete="new-password" id="account-new-password" minLength={MIN_ADMIN_PASSWORD_LENGTH} name="newPassword" required type="password" />
              <Label htmlFor="account-confirm-password">{t("account.confirmNewPassword")}</Label>
              <Input autoComplete="new-password" id="account-confirm-password" minLength={MIN_ADMIN_PASSWORD_LENGTH} name="confirmation" required type="password" />
            </div>
            <DialogFooter>
              <Button disabled={passwordBusy} onClick={() => setCredentialDialog(null)} type="button" variant="outline">{t("common.cancel")}</Button>
              <Button disabled={passwordBusy} type="submit">
                {passwordBusy && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
                {passwordBusy ? t("account.changing") : t("account.changePasswordTitle")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={credentialDialog === "email"}
        onOpenChange={(open) => {
          if (!open && !emailBusy) setCredentialDialog(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <form className="grid gap-5" onSubmit={changeEmail}>
            <DialogHeader>
              <DialogTitle>{t("account.changeEmailTitle")}</DialogTitle>
              <DialogDescription>
                {t("account.changeEmailDescription")}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <Label htmlFor="account-new-email">{t("account.newEmail")}</Label>
              <Input autoComplete="email" autoFocus id="account-new-email" name="email" required type="email" />
              <Label htmlFor="account-email-password">{t("account.currentPassword")}</Label>
              <Input autoComplete="current-password" id="account-email-password" name="currentPassword" required type="password" />
            </div>
            <DialogFooter>
              <Button disabled={emailBusy} onClick={() => setCredentialDialog(null)} type="button" variant="outline">{t("common.cancel")}</Button>
              <Button disabled={emailBusy} type="submit">
                {emailBusy && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
                {emailBusy ? t("account.changing") : t("account.changeEmailTitle")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(confirmation)} onOpenChange={(open) => { if (!open && !confirmationBusy) setConfirmation(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t("account.confirmPasswordTitle")}</DialogTitle><DialogDescription>{t("account.confirmPasswordDescription")}</DialogDescription></DialogHeader>
          <div className="grid gap-2"><Label htmlFor="passkey-current-password">{t("account.currentPassword")}</Label><Input autoComplete="current-password" autoFocus id="passkey-current-password" onChange={(event) => setConfirmationPassword(event.target.value)} type="password" value={confirmationPassword} /></div>
          <DialogFooter><Button disabled={confirmationBusy} onClick={() => setConfirmation(null)} type="button" variant="outline">{t("common.cancel")}</Button><Button disabled={confirmationBusy || !confirmationPassword} onClick={() => void confirmPasskey()} type="button">{confirmationBusy && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />} {confirmation?.action === "add" ? t("account.confirmAndAdd") : t("account.confirmAndDelete")}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
