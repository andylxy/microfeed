import {useState} from "react";

import {showToast} from "@/client/ToastUtils";
import {useTranslation} from "@/client/i18n";
import {Button} from "@/components/ui/button";
import {cn} from "@/lib/utils";
import type {RbacUserBoard} from "@/shared/Rbac";
import {ADMIN_URLS} from "@/shared/StringUtils";

interface Props {
  initialBoard: RbacUserBoard;
  /** The signed-in account, so the page can flag editing yourself. */
  currentUserId?: string;
}

const ROW_CLASS = "w-full rounded-[10px] px-3 py-2 text-left text-sm";

/**
 * Which roles each account holds.
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
              <Button disabled={saving} onClick={save} size="sm" type="button">
                {saving ? t("rbac.saving") : t("rbac.saveUserRoles")}
              </Button>
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
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t("rbac.noUsers")}</p>
        )}
      </section>
    </div>
  );
}
