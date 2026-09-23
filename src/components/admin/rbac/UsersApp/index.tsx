import {useState} from "react";

import {showToast} from "@/client/ToastUtils";
import {useTranslation} from "@/client/i18n";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import LoginCredentialsPanel from "@/components/admin/LoginCredentialsPanel";
import {cn} from "@/lib/utils";
import {
  adminAccountKind,
  MIN_ADMIN_PASSWORD_LENGTH,
  validateAdminEmail,
  validateAdminPassword,
  validateAdminUsername,
} from "@/shared/AdminCredentials";
import {
  DEFAULT_USER_ROLE,
  type RbacUserBoard,
} from "@/shared/Rbac";
import {ADMIN_URLS} from "@/shared/StringUtils";

interface Props {
  initialBoard: RbacUserBoard;
  /** The signed-in account, so the page can flag editing yourself. */
  currentUserId?: string;
}

const ROW_CLASS = "w-full rounded-[10px] px-3 py-2 text-left text-sm";

/** Pull a localized message out of a failed RBAC ajax response. */
async function parseError(response: Response, fallback: string): Promise<string> {
  try {
    const data = (await response.json()) as {error?: string};
    return data.error ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Which roles each account holds, plus account lifecycle (create, ban, delete).
 *
 * Reading and writing both need `system:user:manage` (plan §8.1, the user
 * management row). Without this page the RBAC layer is inert: roles can be
 * given permissions, but nothing could ever be given a role.
 */
export default function UsersApp({initialBoard, currentUserId}: Props) {
  const {t} = useTranslation();
  const [board, setBoard] = useState(initialBoard);
  const [selectedId, setSelectedId] = useState(initialBoard.users[0]?.id ?? "");
  const [saving, setSaving] = useState(false);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newAccount, setNewAccount] = useState("");
  const [newPassword, setNewPassword] = useState("");
  // Pre-ticked `readonly` so a fresh account is never created permission-less.
  const [newRoles, setNewRoles] = useState<string[]>([DEFAULT_USER_ROLE]);

  const user = board.users.find((entry) => entry.id === selectedId);

  const toggle = (code: string, granted: boolean) => {
    if (!user) return;
    const next = granted
      ? [...user.roles, code].sort()
      : user.roles.filter((entry) => entry !== code);
    setBoard({
      ...board,
      users: board.users.map((entry) =>
        entry.id === user.id ? {...entry, roles: next} : entry),
    });
  };

  const save = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxRbacUserRoles(), {
        body: JSON.stringify({roles: user.roles, userId: user.id}),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      if (!response.ok) throw new Error("save failed");
      setBoard(await response.json() as RbacUserBoard);
      showToast(t("rbac.userRolesSaved"), "success");
    } catch {
      showToast(t("rbac.userRolesSaveFailed"), "error");
    } finally {
      setSaving(false);
    }
  };

  const createUser = async () => {
    const name = newName.trim();
    const account = newAccount.trim();
    const password = newPassword;
    if (!name || !account) {
      showToast(t("errors.rbac.invalidNewUser"), "error");
      return;
    }
    // Mirrors the endpoint's checks so the visitor gets the verdict before a
    // round trip; the server re-checks regardless.
    const accountProblem = adminAccountKind(account) === "email"
      ? validateAdminEmail(account) && t("errors.rbac.invalidEmail")
      : validateAdminUsername(account) && t("errors.rbac.invalidUsername");
    if (accountProblem) {
      showToast(accountProblem, "error");
      return;
    }
    if (validateAdminPassword(password)) {
      showToast(
        t("errors.password.policy", {min: MIN_ADMIN_PASSWORD_LENGTH}),
        "error",
      );
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxRbacUserCreate(), {
        body: JSON.stringify({account, name, password, roles: newRoles}),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      if (!response.ok) {
        showToast(await parseError(response, t("errors.rbac.createUserFailed")), "error");
        return;
      }
      const next = (await response.json()) as RbacUserBoard;
      setBoard(next);
      setSelectedId(next.users[0]?.id ?? "");
      setCreating(false);
      setNewName("");
      setNewAccount("");
      setNewPassword("");
      setNewRoles([DEFAULT_USER_ROLE]);
      showToast(t("rbac.userRolesSaved"), "success");
    } catch {
      showToast(t("errors.rbac.createUserFailed"), "error");
    } finally {
      setSaving(false);
    }
  };

  const toggleBan = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxRbacUserBan(), {
        body: JSON.stringify({banned: !user.banned, userId: user.id}),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      if (!response.ok) {
        showToast(await parseError(response, t("errors.rbac.banUserFailed")), "error");
        return;
      }
      setBoard(await response.json() as RbacUserBoard);
      showToast(t("rbac.userRolesSaved"), "success");
    } catch {
      showToast(t("errors.rbac.banUserFailed"), "error");
    } finally {
      setSaving(false);
    }
  };

  const deleteUser = async () => {
    if (!user) return;
    if (!window.confirm(t("rbac.confirmDeleteAccount", {email: user.email}))) return;
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxRbacUserDelete(), {
        body: JSON.stringify({userId: user.id}),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      if (!response.ok) {
        showToast(await parseError(response, t("errors.rbac.deleteUserFailed")), "error");
        return;
      }
      const next = (await response.json()) as RbacUserBoard;
      setBoard(next);
      setSelectedId(next.users[0]?.id ?? "");
      showToast(t("rbac.userRolesSaved"), "success");
    } catch {
      showToast(t("errors.rbac.deleteUserFailed"), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <nav className="w-full shrink-0 rounded-[14px] border bg-card p-2 shadow-xs lg:w-72">
        <ul className="flex flex-col gap-1">
          {board.users.map((entry) => (
            <li key={entry.id}>
              <button
                aria-current={entry.id === selectedId ? "true" : undefined}
                className={cn(
                  ROW_CLASS,
                  entry.id === selectedId
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
                onClick={() => setSelectedId(entry.id)}
                type="button"
              >
                <span className="block truncate">{entry.name || entry.email}</span>
                <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                  {entry.name
                    ? `${entry.email} · ${entry.roles.length}`
                    : entry.roles.length}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="mt-2 border-t p-1 pt-2">
          {creating ? (
            <div className="flex flex-col gap-2 rounded-[10px] border bg-background p-2">
              <Input
                aria-label={t("rbac.accountName")}
                disabled={saving}
                onChange={(event) => setNewName(event.target.value)}
                placeholder={t("rbac.accountName")}
                value={newName}
              />
              <Input
                aria-label={t("rbac.accountIdentifier")}
                disabled={saving}
                onChange={(event) => setNewAccount(event.target.value)}
                placeholder={t("rbac.accountIdentifier")}
                type="text"
                value={newAccount}
              />
              <p className="text-xs text-muted-foreground">
                {t("rbac.accountIdentifierHint")}
              </p>
              <Input
                aria-label={t("rbac.accountPassword")}
                disabled={saving}
                onChange={(event) => setNewPassword(event.target.value)}
                placeholder={t("rbac.accountPassword")}
                type="password"
                value={newPassword}
              />
              <p className="text-xs text-muted-foreground">
                {t("rbac.passwordHint", {min: MIN_ADMIN_PASSWORD_LENGTH})}
              </p>
              <div className="grid gap-1">
                <span className="text-xs text-muted-foreground">
                  {t("rbac.newAccountRoles")}
                </span>
                <ul className="grid gap-0.5">
                  {board.roles.map((role) => (
                    <li key={role.code}>
                      <label className="flex items-center gap-2 text-xs">
                        <input
                          checked={newRoles.includes(role.code)}
                          className="size-3.5 shrink-0"
                          disabled={saving}
                          onChange={(event) => setNewRoles((previous) =>
                            event.target.checked
                              ? [...previous, role.code].sort()
                              : previous.filter((code) => code !== role.code))}
                          type="checkbox"
                        />
                        <span>{role.name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="flex gap-2">
                <Button
                  disabled={saving}
                  onClick={createUser}
                  size="xs"
                  type="button"
                >
                  {t("common.save")}
                </Button>
                <Button
                  disabled={saving}
                  onClick={() => {
                    setCreating(false);
                    setNewName("");
                    setNewAccount("");
                    setNewPassword("");
                    setNewRoles([DEFAULT_USER_ROLE]);
                  }}
                  size="xs"
                  type="button"
                  variant="ghost"
                >
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              className="w-full"
              disabled={saving}
              onClick={() => {
                setNewName("");
                setNewAccount("");
                setNewPassword("");
                setNewRoles([DEFAULT_USER_ROLE]);
                setCreating(true);
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("rbac.newAccount")}
            </Button>
          )}
        </div>
      </nav>

      <section className="min-w-0 flex-1 rounded-[14px] border bg-card p-5 shadow-xs">
        {user ? (
          <>
            <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="truncate font-semibold text-foreground">
                  {user.name || user.email}
                </h2>
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                  {user.email}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button disabled={saving} onClick={save} size="sm" type="button">
                  {saving ? t("rbac.saving") : t("rbac.saveUserRoles")}
                </Button>
                <Button
                  disabled={saving}
                  onClick={toggleBan}
                  size="sm"
                  type="button"
                  variant={user.banned ? "outline" : "secondary"}
                >
                  {user.banned ? t("rbac.unbanAccount") : t("rbac.banAccount")}
                </Button>
                <Button
                  disabled={saving}
                  onClick={deleteUser}
                  size="sm"
                  type="button"
                  variant="destructive"
                >
                  {t("rbac.deleteAccount")}
                </Button>
              </div>
            </header>

            <dl className="mb-4 flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
              <div className="flex gap-1">
                <dt>{t("rbac.legacyRole")}</dt>
                <dd className="font-mono text-foreground">
                  {user.legacyRole ?? t("rbac.legacyRoleNone")}
                </dd>
              </div>
              <div className="flex gap-1">
                <dt>{t("rbac.accountState")}</dt>
                <dd className={cn("font-mono", user.banned ? "text-amber-600 dark:text-amber-300" : "text-foreground")}>
                  {user.banned ? t("rbac.accountBanned") : t("rbac.accountActive")}
                </dd>
              </div>
            </dl>

            {user.id === currentUserId && (
              <p className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                {t("rbac.editingSelfNotice")}
              </p>
            )}

            <p className="mb-4 text-sm leading-6 text-muted-foreground">
              {t("rbac.userRolesDescription")}
            </p>

            <ul className="grid gap-2 sm:grid-cols-2">
              {board.roles.map((role) => (
                <li key={role.code}>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      checked={user.roles.includes(role.code)}
                      className="mt-0.5 size-4 shrink-0"
                      disabled={saving}
                      onChange={(event) => toggle(role.code, event.target.checked)}
                      type="checkbox"
                    />
                    <span className="min-w-0">
                      <span className="block">{role.name}</span>
                      <span className="block font-mono text-xs text-muted-foreground">
                        {role.code}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>

            <div className="mt-6 border-t pt-5">
              <h3 className="text-sm font-medium text-foreground">
                {t("loginCredentials.title")}
              </h3>
              <p className="mt-1 mb-3 text-xs text-muted-foreground">
                {t("loginCredentials.adminDescription")}
              </p>
              <LoginCredentialsPanel key={user.id} userId={user.id} />
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t("rbac.noUsers")}</p>
        )}
      </section>
    </div>
  );
}
