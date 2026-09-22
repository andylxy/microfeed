import {useMemo, useState} from "react";

import {showToast} from "@/client/ToastUtils";
import {useTranslation} from "@/client/i18n";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {ADMIN_URLS} from "@/shared/StringUtils";
import type {RbacBoard} from "@/shared/Rbac";

interface Props {
  initialBoard: RbacBoard;
}

/**
 * Mirrors `RBAC_WILDCARD` on the server. Duplicated on purpose: this is browser
 * code and must not import from `@/server/` (enforced by
 * `tests/unit/source-architecture.test.ts`).
 */
const WILDCARD = "*";

/** Mirrors the server's role-code rule (`^[a-z][a-z0-9_]*$`). */
const ROLE_CODE_PATTERN = /^[a-z][a-z0-9_]*$/u;

/**
 * `content:book` -> `rbac.group.content_book`; `*` -> `rbac.group.all`.
 *
 * The caller falls back to the raw group code when a group has no label yet, so
 * a newly seeded permission shows something readable instead of a missing key.
 */
function groupLabelKey(group: string): string {
  const slug = group
    .replace(/[^a-zA-Z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return `rbac.group.${slug || "all"}`;
}

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
 * Roles and the permissions granted to them.
 *
 * The board is read from `GET /ajax/rbac` (`system:role:manage`) and written
 * back with `POST /ajax/rbac/role-permissions` (`system:permission:manage`).
 * `super_admin` is read-only here: its access comes from the `*` wildcard, so
 * an assignment that stripped it would lock every administrator out. Roles can
 * also be created, renamed and deleted through the sibling endpoints.
 */
export default function RbacApp({initialBoard}: Props) {
  const {t} = useTranslation();
  const [board, setBoard] = useState(initialBoard);
  const [selected, setSelected] = useState(initialBoard.roles[0]?.code ?? "");
  const [saving, setSaving] = useState(false);

  const [creating, setCreating] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  const role = board.roles.find((entry) => entry.code === selected);
  const isWildcardRole = role?.code === "super_admin";

  // `module:resource:action` groups by the first two segments, so the grid reads
  // as "books / categories / volumes / system" instead of one flat list.
  const groups = useMemo(() => {
    const map = new Map<string, {code: string; name: string}[]>();
    for (const permission of board.permissions) {
      // The wildcard is never assignable here: it means "everything", so
      // ticking it on an ordinary role would turn that role into a super
      // administrator and make `system:permission:manage` an escalation path.
      if (permission.code === WILDCARD) continue;
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

  const createRole = async () => {
    const code = newCode.trim();
    const name = newName.trim();
    if (!ROLE_CODE_PATTERN.test(code) || !name) {
      showToast(t("errors.rbac.invalidRole"), "error");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxRbacRoles(), {
        body: JSON.stringify({code, name}),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      if (!response.ok) {
        showToast(await parseError(response, t("errors.rbac.duplicateRole")), "error");
        return;
      }
      const next = (await response.json()) as RbacBoard;
      setBoard(next);
      setSelected(code);
      setCreating(false);
      setNewCode("");
      setNewName("");
      showToast(t("rbac.saved"), "success");
    } catch {
      showToast(t("errors.rbac.duplicateRole"), "error");
    } finally {
      setSaving(false);
    }
  };

  const startRename = () => {
    if (!role) return;
    setRenaming(true);
    setRenameValue(role.name);
  };

  const saveRename = async () => {
    if (!role) return;
    const name = renameValue.trim();
    if (!name) {
      showToast(t("errors.rbac.invalidRole"), "error");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxRbacRoleName(), {
        body: JSON.stringify({code: role.code, name}),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      if (!response.ok) {
        showToast(await parseError(response, t("errors.rbac.reservedRole")), "error");
        return;
      }
      setBoard(await response.json() as RbacBoard);
      setRenaming(false);
      showToast(t("rbac.saved"), "success");
    } catch {
      showToast(t("errors.rbac.reservedRole"), "error");
    } finally {
      setSaving(false);
    }
  };

  const deleteRole = async () => {
    if (!role) return;
    if (!window.confirm(t("rbac.confirmDeleteRole", {name: role.name}))) return;
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxRbacRoleDelete(), {
        body: JSON.stringify({code: role.code}),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      if (!response.ok) {
        showToast(await parseError(response, t("errors.rbac.roleInUse")), "error");
        return;
      }
      const next = (await response.json()) as RbacBoard;
      setBoard(next);
      setSelected(next.roles[0]?.code ?? "");
      showToast(t("rbac.saved"), "success");
    } catch {
      showToast(t("errors.rbac.roleInUse"), "error");
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

        <div className="mt-2 border-t p-1 pt-2">
          {creating ? (
            <div className="flex flex-col gap-2 rounded-[10px] border bg-background p-2">
              <Input
                aria-label={t("rbac.roleCode")}
                disabled={saving}
                onChange={(event) => setNewCode(event.target.value)}
                placeholder={t("rbac.roleCodePlaceholder")}
                value={newCode}
              />
              <Input
                aria-label={t("rbac.roleName")}
                disabled={saving}
                onChange={(event) => setNewName(event.target.value)}
                placeholder={t("rbac.roleName")}
                value={newName}
              />
              <div className="flex gap-2">
                <Button
                  disabled={saving}
                  onClick={createRole}
                  size="xs"
                  type="button"
                >
                  {t("common.save")}
                </Button>
                <Button
                  disabled={saving}
                  onClick={() => {
                    setCreating(false);
                    setNewCode("");
                    setNewName("");
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
                setNewCode("");
                setNewName("");
                setCreating(true);
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("rbac.newRole")}
            </Button>
          )}
        </div>
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
              {renaming ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    aria-label={t("rbac.roleName")}
                    className="w-44"
                    disabled={saving}
                    onChange={(event) => setRenameValue(event.target.value)}
                    value={renameValue}
                  />
                  <Button
                    disabled={saving}
                    onClick={saveRename}
                    size="sm"
                    type="button"
                  >
                    {t("common.save")}
                  </Button>
                  <Button
                    disabled={saving}
                    onClick={() => setRenaming(false)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {t("common.cancel")}
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    disabled={saving || isWildcardRole}
                    onClick={save}
                    size="sm"
                    type="button"
                  >
                    {saving ? t("rbac.saving") : t("rbac.save")}
                  </Button>
                  <Button
                    disabled={saving || isWildcardRole}
                    onClick={startRename}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {t("rbac.rename")}
                  </Button>
                  <Button
                    disabled={saving || isWildcardRole}
                    onClick={deleteRole}
                    size="sm"
                    type="button"
                    variant="destructive"
                  >
                    {t("rbac.deleteRole")}
                  </Button>
                </div>
              )}
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
                  <h3 className="mb-2 text-xs font-medium uppercase text-muted-foreground">
                    {t(groupLabelKey(group), {defaultValue: group})}
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
