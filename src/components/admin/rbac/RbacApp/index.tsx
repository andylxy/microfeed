import {useMemo, useState} from "react";

import {showToast} from "@/client/ToastUtils";
import {useTranslation} from "@/client/i18n";
import {Button} from "@/components/ui/button";
import {ADMIN_URLS} from "@/shared/StringUtils";
import type {RbacBoard} from "@/shared/Rbac";

interface Props {
  initialBoard: RbacBoard;
}

/**
 * Roles and the permissions granted to them.
 *
 * The board is read from `GET /ajax/rbac` (`system:role:manage`) and written
 * back with `POST /ajax/rbac/role-permissions` (`system:permission:manage`).
 * `super_admin` is read-only here: its access comes from the `*` wildcard, so
 * an assignment that stripped it would lock every administrator out.
 */
export default function RbacApp({initialBoard}: Props) {
  const {t} = useTranslation();
  const [board, setBoard] = useState(initialBoard);
  const [selected, setSelected] = useState(initialBoard.roles[0]?.code ?? "");
  const [saving, setSaving] = useState(false);

  const role = board.roles.find((entry) => entry.code === selected);
  const isWildcardRole = role?.code === "super_admin";

  // `module:resource:action` groups by the first two segments, so the grid reads
  // as "books / categories / volumes / system" instead of one flat list.
  const groups = useMemo(() => {
    const map = new Map<string, {code: string; name: string}[]>();
    for (const permission of board.permissions) {
      const key = permission.code.split(":").slice(0, 2).join(":");
      const list = map.get(key) ?? [];
      list.push(permission);
      map.set(key, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [board.permissions]);

  const toggle = (code: string, granted: boolean) => {
    if (!role) return;
    const next = granted
      ? [...role.permissions, code].sort()
      : role.permissions.filter((entry) => entry !== code);
    setBoard({
      ...board,
      roles: board.roles.map((entry) =>
        entry.code === role.code ? {...entry, permissions: next} : entry),
    });
  };

  const save = async () => {
    if (!role) return;
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxRbacRolePermissions(), {
        body: JSON.stringify({permissions: role.permissions, role: role.code}),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      if (!response.ok) throw new Error("save failed");
      setBoard(await response.json() as RbacBoard);
      showToast(t("rbac.saved"), "success");
    } catch {
      showToast(t("rbac.saveFailed"), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <nav className="w-full shrink-0 rounded-[14px] border bg-card p-2 shadow-xs lg:w-64">
        <ul className="flex flex-col gap-1">
          {board.roles.map((entry) => (
            <li key={entry.code}>
              <button
                aria-current={entry.code === selected ? "true" : undefined}
                className={
                  entry.code === selected
                    ? "w-full rounded-[10px] bg-muted px-3 py-2 text-left text-sm font-medium text-foreground"
                    : "w-full rounded-[10px] px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                }
                onClick={() => setSelected(entry.code)}
                type="button"
              >
                <span className="block">{entry.name}</span>
                <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
                  {entry.code} · {entry.permissions.length}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <section className="min-w-0 flex-1 rounded-[14px] border bg-card p-5 shadow-xs">
        {role ? (
          <>
            <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold text-foreground">{role.name}</h2>
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  {role.code}
                </p>
              </div>
              <Button
                disabled={saving || isWildcardRole}
                onClick={save}
                size="sm"
                type="button"
              >
                {saving ? t("rbac.saving") : t("rbac.save")}
              </Button>
            </header>

            {isWildcardRole && (
              <p className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                {t("rbac.wildcardRoleNotice")}
              </p>
            )}

            <p className="mb-4 text-sm leading-6 text-muted-foreground">
              {t("rbac.description")}
            </p>

            <div className="flex flex-col gap-5">
              {groups.map(([group, permissions]) => (
                <div key={group}>
                  <h3 className="mb-2 font-mono text-xs uppercase text-muted-foreground">
                    {group}
                  </h3>
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {permissions.map((permission) => (
                      <li key={permission.code}>
                        <label className="flex items-start gap-2 text-sm">
                          <input
                            checked={role.permissions.includes(permission.code)}
                            className="mt-0.5 size-4 shrink-0"
                            disabled={isWildcardRole || saving}
                            onChange={(event) =>
                              toggle(permission.code, event.target.checked)}
                            type="checkbox"
                          />
                          <span className="min-w-0">
                            <span className="block">{permission.name}</span>
                            <span className="block font-mono text-xs text-muted-foreground">
                              {permission.code}
                            </span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t("rbac.noRoles")}</p>
        )}
      </section>
    </div>
  );
}
