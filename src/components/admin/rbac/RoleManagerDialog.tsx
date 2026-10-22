import {useState} from "react";

import {useTranslation} from "@/client/i18n";
import {Button} from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {Input} from "@/components/ui/input";
import {Switch} from "@/components/ui/switch";
import {cn} from "@/lib/utils";
import type {RbacBoardRole} from "@/shared/Rbac";

/** 角色代码的稳定身份被代码依赖，字符集与服务端校验同一套。 */
const ROLE_CODE_PATTERN = /^[a-z][a-z0-9_]*$/u;

/** 代码被代码依赖的角色（`super_admin` 持通配、`readonly` 是新账号默认角色）。 */
const CODE_LOCKED_ROLES = new Set(["super_admin", "readonly"]);

const ROW_CLASS = "w-full rounded-[10px] px-3 py-2 text-left text-sm";

export interface RoleDraft {
  code: string;
  name: string;
}

export interface RoleManagerPanelsProps {
  /** 角色持有多少权限码（两端合并后的数，由调用方算）。 */
  countOf: (code: string) => number;
  /** 新建角色；返回 `false` 表示服务端拒绝，表单保持打开。 */
  onCreate: (draft: RoleDraft) => Promise<boolean>;
  /** 改「登录后台」开关；返回 `false` 表示服务端拒绝（如 super_admin 固定为允许）。 */
  onAdminLogin: (code: string, allow: boolean) => Promise<boolean>;
  /** 改「会员」标记；返回 `false` 表示服务端拒绝。 */
  onMember: (code: string, member: boolean) => Promise<boolean>;
  /** 删除角色；返回 `false` 表示服务端拒绝。 */
  onDelete: (code: string) => Promise<boolean>;
  /** 左列换选：页面上的授权树跟着换角色。 */
  onSelect: (code: string) => void;
  /** 改名与改代码合并成一次提交，避免两次往返中间留下半改状态。 */
  onUpdate: (current: RoleDraft, next: RoleDraft) => Promise<boolean>;
  /** 全量角色目录（PC 板子，两端角色清单同源）。 */
  roles: RbacBoardRole[];
  saving: boolean;
  selectedCode: string;
}

/**
 * 角色管理的两栏内容：左列角色列表（名称 + 代码 + 授权数，底部「新建角色」
 * 展开成表单），右栏选中角色的详情（显示名称与角色代码各带一个编辑入口，
 * 删除在标题右侧）——照用户管理页的语法。
 */
export function RoleManagerPanels({
  countOf,
  onAdminLogin,
  onCreate,
  onDelete,
  onMember,
  onSelect,
  onUpdate,
  roles,
  saving,
  selectedCode,
}: RoleManagerPanelsProps) {
  const {t} = useTranslation();
  const [active, setActive] = useState(selectedCode);
  const [creating, setCreating] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [editingCode, setEditingCode] = useState(false);
  const [codeDraft, setCodeDraft] = useState("");

  const role = roles.find((entry) => entry.code === active) ?? roles[0];
  const codeLocked = role ? CODE_LOCKED_ROLES.has(role.code) : false;
  const isWildcard = role?.code === "super_admin";

  const resetEdits = () => {
    setEditingName(false);
    setEditingCode(false);
    setNameDraft("");
    setCodeDraft("");
  };

  const pick = (code: string) => {
    setActive(code);
    onSelect(code);
    resetEdits();
  };

  const submitCreate = async () => {
    const code = newCode.trim();
    const name = newName.trim();
    if (!ROLE_CODE_PATTERN.test(code) || !name) return;
    if (!(await onCreate({code, name}))) return;
    setActive(code);
    setCreating(false);
    setNewCode("");
    setNewName("");
  };

  const submitName = async () => {
    if (!role) return;
    const name = nameDraft.trim();
    if (!name) return;
    if (!(await onUpdate({code: role.code, name: role.name}, {code: role.code, name}))) {
      setNameDraft(role.name);
      return;
    }
    setEditingName(false);
    setNameDraft("");
  };

  const submitCode = async () => {
    if (!role) return;
    const code = codeDraft.trim();
    if (!ROLE_CODE_PATTERN.test(code) || code === role.code) {
      setCodeDraft(role.code);
      return;
    }
    if (!(await onUpdate({code: role.code, name: role.name}, {code, name: role.name}))) {
      setCodeDraft(role.code);
      return;
    }
    setActive(code);
    setEditingCode(false);
    setCodeDraft("");
  };

  const toggleAdminLogin = async (allow: boolean) => {
    if (!role) return;
    await onAdminLogin(role.code, allow);
  };

  const toggleMember = async (member: boolean) => {
    if (!role) return;
    await onMember(role.code, member);
  };

  const removeRole = async () => {
    if (!role) return;
    if (!(await onDelete(role.code))) return;
    setActive(roles.find((entry) => entry.code !== role.code)?.code ?? "");
    resetEdits();
  };

  return (
    <div className="grid gap-4 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
      <nav className="rounded-[12px] border p-2">
        <ul className="flex max-h-[min(58vh,26rem)] flex-col gap-1 overflow-y-auto">
          {roles.map((entry) => (
            <li key={entry.code}>
              <button
                aria-current={entry.code === active ? "true" : undefined}
                className={cn(
                  ROW_CLASS,
                  entry.code === active
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
                onClick={() => pick(entry.code)}
                type="button"
              >
                <span className="block truncate">
                  {entry.name}
                  {entry.code === "super_admin" && " *"}
                </span>
                <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                  {`${entry.code} · ${countOf(entry.code)} ${t("rbac.roleGrantCountUnit")}`}
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
                  onClick={() => void submitCreate()}
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
                resetEdits();
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

      <section className="min-w-0 rounded-[12px] border p-4">
        {role ? (
          <>
            <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="truncate font-semibold text-foreground">
                  {role.name}
                  {isWildcard && " *"}
                </h3>
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                  {role.code}
                </p>
              </div>
              <Button
                disabled={saving || codeLocked}
                onClick={() => void removeRole()}
                size="sm"
                type="button"
                variant="destructive"
              >
                {t("rbac.deleteRole")}
              </Button>
            </header>

            <p className="mb-4 text-xs text-muted-foreground">
              {isWildcard
                ? t("rbac.wildcardRoleNotice")
                : codeLocked
                  ? t("rbac.roleCodeLocked")
                  : t("rbac.roleManagerHint")}
            </p>

            <div className="flex flex-col gap-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-20 shrink-0 text-xs text-muted-foreground">
                  {t("rbac.roleName")}
                </span>
                {editingName ? (
                  <>
                    <Input
                      aria-label={t("rbac.roleName")}
                      className="h-8 w-48"
                      disabled={saving}
                      onChange={(event) => setNameDraft(event.target.value)}
                      value={nameDraft}
                    />
                    <Button
                      disabled={saving}
                      onClick={() => void submitName()}
                      size="xs"
                      type="button"
                    >
                      {t("common.save")}
                    </Button>
                    <Button
                      disabled={saving}
                      onClick={() => {
                        setEditingName(false);
                        setNameDraft("");
                      }}
                      size="xs"
                      type="button"
                      variant="ghost"
                    >
                      {t("common.cancel")}
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 font-mono text-foreground">{role.name}</span>
                    <Button
                      disabled={saving}
                      onClick={() => {
                        setNameDraft(role.name);
                        setEditingName(true);
                      }}
                      size="xs"
                      type="button"
                      variant="ghost"
                    >
                      {t("rbac.editName")}
                    </Button>
                  </>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="w-20 shrink-0 text-xs text-muted-foreground">
                  {t("rbac.roleCode")}
                </span>
                {editingCode ? (
                  <>
                    <Input
                      aria-label={t("rbac.roleCode")}
                      className="h-8 w-48"
                      disabled={saving}
                      onChange={(event) => setCodeDraft(event.target.value)}
                      value={codeDraft}
                    />
                    <Button
                      disabled={saving}
                      onClick={() => void submitCode()}
                      size="xs"
                      type="button"
                    >
                      {t("common.save")}
                    </Button>
                    <Button
                      disabled={saving}
                      onClick={() => {
                        setEditingCode(false);
                        setCodeDraft("");
                      }}
                      size="xs"
                      type="button"
                      variant="ghost"
                    >
                      {t("common.cancel")}
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 font-mono text-foreground">{role.code}</span>
                    <Button
                      disabled={saving || codeLocked}
                      onClick={() => {
                        setCodeDraft(role.code);
                        setEditingCode(true);
                      }}
                      size="xs"
                      type="button"
                      variant="ghost"
                    >
                      {t("rbac.editRoleCode")}
                    </Button>
                  </>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="w-20 shrink-0 text-xs text-muted-foreground">
                  {t("rbac.roleGrantCountLabel")}
                </span>
                <span className="font-mono text-foreground">
                  {`${countOf(role.code)} ${t("rbac.roleGrantCountUnit")}`}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="w-20 shrink-0 text-xs text-muted-foreground">
                  {t("rbac.adminLogin")}
                </span>
                <Switch
                  aria-label={t("rbac.adminLogin")}
                  checked={role.allowAdminLogin}
                  disabled={saving || isWildcard}
                  onCheckedChange={(next) => void toggleAdminLogin(next)}
                  size="sm"
                />
                <span className="text-xs text-foreground">
                  {role.allowAdminLogin
                    ? t("rbac.adminLoginAllowed")
                    : t("rbac.adminLoginDenied")}
                </span>
                {isWildcard && (
                  <span className="text-xs text-muted-foreground">
                    {t("rbac.adminLoginLocked")}
                  </span>
                )}
              </div>

              <p className="text-xs text-muted-foreground">
                {t("rbac.adminLoginHint")}
              </p>

              <div className="flex flex-wrap items-center gap-2">
                <span className="w-20 shrink-0 text-xs text-muted-foreground">
                  {t("rbac.member")}
                </span>
                <Switch
                  aria-label={t("rbac.member")}
                  checked={role.isMember}
                  disabled={saving}
                  onCheckedChange={(next) => void toggleMember(next)}
                  size="sm"
                />
                <span className="text-xs text-foreground">
                  {role.isMember ? t("rbac.memberEnabled") : t("rbac.memberDisabled")}
                </span>
              </div>

              <p className="text-xs text-muted-foreground">
                {t("rbac.memberHint")}
              </p>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t("rbac.noRoles")}</p>
        )}
      </section>
    </div>
  );
}

interface DialogProps extends RoleManagerPanelsProps {
  onClose: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

/**
 * 角色管理弹窗：页面角色条只负责「当前给谁配权限」，新建与维护都收在这里，
 * 免得在角色条上塞输入框把宽度挤爆。
 */
export default function RoleManagerDialog({
  onClose,
  onOpenChange,
  open,
  ...panels
}: DialogProps) {
  const {t} = useTranslation();
  return (
    <Dialog
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) onClose();
      }}
      open={open}
    >
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader className="border-b pb-2 pr-8">
          <DialogTitle>{t("rbac.roleManagerTitle")}</DialogTitle>
        </DialogHeader>
        <RoleManagerPanels {...panels} />
      </DialogContent>
    </Dialog>
  );
}
