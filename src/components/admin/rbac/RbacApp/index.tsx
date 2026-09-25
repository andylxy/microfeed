import {ChevronRightIcon} from "lucide-react";

import {useMemo, useState} from "react";

import {showToast} from "@/client/ToastUtils";
import {useTranslation} from "@/client/i18n";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {cn} from "@/lib/utils";
import {menuGroupLabelKey, menuItemLabelKey} from "@/shared/AdminNavigation";
import {ADMIN_URLS} from "@/shared/StringUtils";
import {
  permissionBranchState,
  RBAC_OTHER_GROUP,
  RBAC_OTHER_PAGE,
  togglePermissionBranch,
  type RbacBoard,
} from "@/shared/Rbac";

interface Props {
  initialBoard: RbacBoard;
}

/** Mirrors the server's role-code rule (`^[a-z][a-z0-9_]*$`). */
const ROLE_CODE_PATTERN = /^[a-z][a-z0-9_]*$/u;

/**
 * A tree group heading. A menu group reads `menu.group.<slug>`; the catch-all
 * (codes no menu page maps to) has its own label.
 */
function groupLabelKey(code: string): string {
  return code === RBAC_OTHER_GROUP
    ? "rbac.otherPermissions"
    : menuGroupLabelKey(code);
}

/**
 * The synthetic root node — "权限管理". It is not a menu row or a permission
 * code; it exists so the editor has one place that selects the whole tree.
 */
const ROOT_NODE = "permission_root";

/** A tree page heading. A menu page reads `menu.item.<code>`. */
function pageLabelKey(code: string): string {
  return code === RBAC_OTHER_PAGE
    ? "rbac.uncategorised"
    : menuItemLabelKey(code);
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
 * The board is rendered server-side into the page (`/rbac/`) and written back
 * with `POST /ajax/rbac/role-permissions`. Every RBAC endpoint is gated by
 * `system:role:manage`, so anything this screen offers is either allowed or
 * invisible to the signed-in account — there is no partial board.
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
  const [renameCode, setRenameCode] = useState("");
  // Collapse state for the tree, keyed by node code. Absent means expanded, so
  // the whole tree is open on first render (M10: 默认全部展开).
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const isOpen = (code: string) => !collapsed[code];
  const toggleOpen = (code: string) =>
    setCollapsed((previous) => ({...previous, [code]: !previous[code]}));

  const role = board.roles.find((entry) => entry.code === selected);
  const isWildcardRole = role?.code === "super_admin";
  // Codes the server refuses to change: `super_admin` (the wildcard holder) and
  // `readonly` (the default role a new account receives). See CODE_LOCKED_ROLES.
  const isCodeLocked = role?.code === "super_admin" || role?.code === "readonly";

  // The tree comes from the server (menu groups -> pages -> codes); the cascade
  // state is a pure, shared helper so the editor and its tests agree.
  //
  // `allCodes` is every real grant in the tree, so the root branch ("权限管理")
  // toggles the whole set.
  const allCodes = useMemo(
    () => board.groups.flatMap((group) => group.pages).flatMap((page) => page.codes),
    [board.groups],
  );
  // A wildcard holder is granted `*`, which the tree deliberately does not
  // render — without this it would show an empty, disabled tree. Treat it as
  // "everything selected" (M6: 整树选中且只读); the whole tree stays disabled.
  const grantedCodes = isWildcardRole
    ? new Set(allCodes)
    : new Set(role?.permissions ?? []);

  /** The collapse arrow. The whole tree starts expanded (M10). */
  const branchToggle = (code: string, label: string) => (
    <button
      aria-expanded={isOpen(code)}
      aria-label={t("rbac.toggleBranch", {name: label})}
      className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground outline-none transition hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40"
      onClick={() => toggleOpen(code)}
      type="button"
    >
      <ChevronRightIcon
        aria-hidden="true"
        className={cn("size-4 transition-transform", isOpen(code) && "rotate-90")}
      />
    </button>
  );

  /** A branch checkbox: grants or revokes every code beneath the branch, and
   * renders `indeterminate` when only part of it is granted. */
  const branchCheckbox = (codes: string[]) => {
    const state = permissionBranchState(codes, grantedCodes);
    return (
      <input
        checked={state.checked}
        className="size-4 shrink-0"
        disabled={isWildcardRole || saving}
        onChange={(event) => toggleCodes(codes, event.target.checked)}
        ref={(element) => {
          if (element) element.indeterminate = state.indeterminate;
        }}
        type="checkbox"
      />
    );
  };
  const permissionNames = useMemo(
    () => new Map(board.permissions.map((entry) => [entry.code, entry.name])),
    [board.permissions],
  );

  /**
   * Grant or revoke a branch at once, so a group/page checkbox toggles every
   * code beneath it; a leaf passes a single code.
   */
  const toggleCodes = (codes: string[], granted: boolean) => {
    if (!role) return;
    const next = togglePermissionBranch(role.permissions, codes, granted);
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
    setRenameCode(role.code);
  };

  /**
   * Select a role from the sidebar. While the rename form is open its inputs
   * are seeded from the role that was selected when it opened, so switching
   * roles without re-seeding them left the form showing the *previous* role's
   * code and name. Re-seed from the newly selected role so the form always
   * describes the role on screen.
   */
  const selectRole = (code: string) => {
    setSelected(code);
    if (!renaming) return;
    const next = board.roles.find((entry) => entry.code === code);
    setRenameValue(next?.name ?? "");
    setRenameCode(next?.code ?? "");
  };

  const saveRename = async () => {
    if (!role) return;
    const name = renameValue.trim();
    const newCode = renameCode.trim();
    if (!name || !newCode) {
      showToast(t("errors.rbac.invalidRole"), "error");
      return;
    }
    const changingCode = newCode !== role.code;
    if (changingCode && !ROLE_CODE_PATTERN.test(newCode)) {
      showToast(t("errors.rbac.invalidRole"), "error");
      return;
    }
    setSaving(true);
    try {
      // Change the code first: it returns a fresh board whose role list already
      // carries the new code, so the name update below targets the new code.
      if (changingCode) {
        const codeResponse = await fetch(ADMIN_URLS.ajaxRbacRoleCode(), {
          body: JSON.stringify({code: role.code, newCode}),
          headers: {"content-type": "application/json"},
          method: "POST",
        });
        if (!codeResponse.ok) {
          showToast(
            await parseError(codeResponse, t("errors.rbac.reservedRole")),
            "error",
          );
          return;
        }
        setBoard(await codeResponse.json() as RbacBoard);
        setSelected(newCode);
      }
      if (name !== role.name) {
        const nameResponse = await fetch(ADMIN_URLS.ajaxRbacRoleName(), {
          body: JSON.stringify({code: newCode, name}),
          headers: {"content-type": "application/json"},
          method: "POST",
        });
        if (!nameResponse.ok) {
          showToast(
            await parseError(nameResponse, t("errors.rbac.reservedRole")),
            "error",
          );
          return;
        }
        setBoard(await nameResponse.json() as RbacBoard);
      }
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
                onClick={() => selectRole(entry.code)}
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
                    aria-label={t("rbac.roleCode")}
                    className="w-40"
                    disabled={saving || isCodeLocked}
                    onChange={(event) => setRenameCode(event.target.value)}
                    placeholder={t("rbac.roleCodePlaceholder")}
                    value={renameCode}
                  />
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

            {isCodeLocked && (
              <p className="mb-4 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
                {t("rbac.roleCodeLocked")}
              </p>
            )}

            {isWildcardRole && (
              <p className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                {t("rbac.wildcardRoleNotice")}
              </p>
            )}

            <p className="mb-4 text-sm leading-6 text-muted-foreground">
              {t("rbac.description")}
            </p>

            <div className="flex flex-col gap-2">
              {/* Root — 权限管理: selects the whole tree. */}
              <div>
                <div className="flex items-center gap-1">
                  {branchToggle(ROOT_NODE, t("rbac.permissionsRoot"))}
                  <label className="flex items-center gap-2">
                    {branchCheckbox(allCodes)}
                    <span className="text-sm font-semibold text-foreground">
                      {t("rbac.permissionsRoot")}
                    </span>
                  </label>
                </div>

                {isOpen(ROOT_NODE) && (
                  <div className="mt-2 flex flex-col gap-2 border-l pl-4">
                    {board.groups.map((group) => {
                      const groupCodes = group.pages.flatMap((page) => page.codes);
                      const groupLabel = t(groupLabelKey(group.code), {
                        defaultValue: group.code,
                      });
                      return (
                        <div key={group.code}>
                          <div className="flex items-center gap-1">
                            {branchToggle(group.code, groupLabel)}
                            <label className="flex items-center gap-2">
                              {branchCheckbox(groupCodes)}
                              <span className="text-sm font-semibold text-foreground">
                                {groupLabel}
                              </span>
                            </label>
                          </div>

                          {isOpen(group.code) && (
                            <div className="mt-2 flex flex-col gap-3 border-l pl-4">
                              {group.pages.map((page) => {
                                const pageLabel = t(pageLabelKey(page.code), {
                                  defaultValue: page.code,
                                });
                                return (
                                  <div key={page.code}>
                                    <div className="flex items-center gap-1">
                                      {branchToggle(page.code, pageLabel)}
                                      <label className="flex items-center gap-2">
                                        {branchCheckbox(page.codes)}
                                        <span className="text-xs font-medium uppercase text-muted-foreground">
                                          {pageLabel}
                                        </span>
                                      </label>
                                    </div>

                                    {isOpen(page.code) && (
                                      <ul className="mt-1 grid gap-2 sm:grid-cols-2">
                                        {page.codes.map((code) => (
                                          <li key={code}>
                                            <label className="flex items-start gap-2 text-sm">
                                              <input
                                                checked={grantedCodes.has(code)}
                                                className="mt-0.5 size-4 shrink-0"
                                                disabled={isWildcardRole || saving}
                                                onChange={(event) =>
                                                  toggleCodes([code], event.target.checked)}
                                                type="checkbox"
                                              />
                                              <span className="min-w-0">
                                                <span className="block">
                                                  {permissionNames.get(code) ?? code}
                                                </span>
                                                <span className="block font-mono text-xs text-muted-foreground">
                                                  {code}
                                                </span>
                                              </span>
                                            </label>
                                          </li>
                                        ))}
                                      </ul>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t("rbac.noRoles")}</p>
        )}
      </section>
    </div>
  );
}
