import {Fragment, useState} from "react";
import {PlusIcon, Trash2Icon, UsersIcon} from "lucide-react";

import {showToast} from "@/client/ToastUtils";
import {useTranslation} from "@/client/i18n";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {AdminGroupTree} from "@/components/admin/shared/AdminGroupTree";import AdminSelect from "@/components/admin/shared/AdminSelect";
import AdminDialog from "@/components/admin/shared/AdminDialog";
import LoginCredentialsPanel from "@/components/admin/LoginCredentialsPanel";
import {cn} from "@/lib/utils";
import {
  isReservedAdminEmailDomain,
  MIN_ADMIN_PASSWORD_LENGTH,
  normalizeAdminEmail,
  validateAdminEmail,
  validateAdminPassword,
  validateAdminUsername,
} from "@/shared/AdminCredentials";
import {
  DEFAULT_USER_ROLE,
  type RbacUser,
  type RbacUserBoard,
} from "@/shared/Rbac";
import {
  BANNED_GROUP_VALUE,
  BUILTIN_SIGNUP_SOURCES,
  hasSignupSource,
  isValidSignupSourceValue,
  matchesSignupCategory,
  type SignupSourceOption,
} from "@/shared/SignupSource";
import {ADMIN_URLS} from "@/shared/StringUtils";

interface Props {
  initialBoard: RbacUserBoard;
  /** `settings` 里已配置的注册来源（`signup_sources`），左栏分组与详情下拉都读它。 */
  initialSignupSources: SignupSourceOption[];
  /** The signed-in account, so the page can flag editing yourself. */
  currentUserId?: string;
}

/** 搜索框匹配的用户字段（名称 / 邮箱 / 用户名）。 */
function userMatchesQuery(user: RbacUser, query: string): boolean {
  const haystack = `${user.name}\u0000${user.email}\u0000${user.username ?? ""}`.toLowerCase();
  return haystack.includes(query);
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
 * Which roles each account holds, plus account lifecycle (create, ban, delete).
 *
 * Reading and writing both need `system:user:manage` (plan §8.1, the user
 * management row). Without this page the RBAC layer is inert: roles can be
 * given permissions, but nothing could ever be given a role.
 */
export default function UsersApp({
  initialBoard,
  initialSignupSources,
  currentUserId,
}: Props) {
  const {t} = useTranslation();
  const [board, setBoard] = useState(initialBoard);
  const [selectedId, setSelectedId] = useState(initialBoard.users[0]?.id ?? "");
  const [saving, setSaving] = useState(false);

  // 分类手风琴：后台用户页按注册来源分组，根节点是静态「全部用户」。null 表示
  // 全部分类折叠（默认态）。单层手风琴——展开一个分类会收起其余。
  //
  // 分组清单不是写死的三个枚举，而是 `settings` 的 `signup_sources`：在
  // 「新建分组」弹层里增删改名后，左栏立刻按新清单重新分桶。列表之外没有
  // 「其他」分组——建号链路写死的三项不允许删，仍有账号在用的来源也不允许删，
  // 所以 `auth_user.signup_source` 恒在列表内。
  const [signupSources, setSignupSources] = useState<SignupSourceOption[]>(initialSignupSources);
  const sourceValues = signupSources.map((option) => option.value);
  // 「已封禁账号」固定追加在末尾：成员由 `banned` 实时过滤，不进来源配置。
  // 服务端读配置时会把「库里出现过、配置里没有」的来源一并补进来，所以这里
  // 不需要再兜一个「其他」分组。
  const categoryList = [...sourceValues, BANNED_GROUP_VALUE];
  const categoryLabel = (category: string): string =>
    category === BANNED_GROUP_VALUE
      ? t("rbac.userGroupBanned")
      : signupSources.find((option) => option.value === category)?.label ?? category;

  const [openCategory, setOpenCategory] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const searchActive = search.trim().length > 0;
  const query = search.trim().toLowerCase();

  /** 分组 → 成员。`__banned__` 按 `banned` 过滤，来源分组排除已封禁账号。 */
  const categoryUsers = (category: string) =>
    board.users.filter((entry) => matchesSignupCategory(entry, category));

  // 搜索优先于手风琴：有查询词时每个分类只保留命中的用户，且只有含命中的
  // 分类被强制展开，无命中则整类收起（spec §9）。
  const categoryVisibleUsers = (category: string) => {
    const users = categoryUsers(category);
    return searchActive ? users.filter((entry) => userMatchesQuery(entry, query)) : users;
  };
  const visibleUsers = searchActive
    ? board.users.filter((entry) => userMatchesQuery(entry, query))
    : openCategory
      ? categoryUsers(openCategory)
      : [];

  // 点一个分类：收起态则展开，已是展开态则全部收起（spec §2「再点已展开的
  // 组头 = 全折叠」）。
  const toggleCategory = (category: string) => {
    const next = openCategory === category ? null : category;
    setOpenCategory(next);
    if (next) {
      const first = categoryUsers(next)[0];
      if (first) setSelectedId(first.id);
    }
  };

  // 全部收起，只留各分类组头在根节点下。
  const collapseAll = () => setOpenCategory(null);

  // 让选中项保持在可见集合内：选中账号被过滤掉时回退到第一个可见账号。
  const visibleUser = visibleUsers.find((entry) => entry.id === selectedId) ?? visibleUsers[0];

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  // The username and the address are two separate fields: the username is the
  // identity and is required, the address is optional.
  const [newUsername, setNewUsername] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  // Pre-ticked `readonly` so a fresh account is never created permission-less.
  const [newRoles, setNewRoles] = useState<string[]>([DEFAULT_USER_ROLE]);

  // Inline profile edits (display name, email, username) and the
  // password-reset modal.
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [editingEmail, setEditingEmail] = useState(false);
  const [emailDraft, setEmailDraft] = useState("");
  const [editingUsername, setEditingUsername] = useState(false);
  const [usernameDraft, setUsernameDraft] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");

  // 「新建分组」弹层：来源列表的草稿副本，点保存才整表覆盖写。
  const [groupOpen, setGroupOpen] = useState(false);
  const [draftSources, setDraftSources] = useState<SignupSourceOption[]>([]);
  const [newSource, setNewSource] = useState({label: "", value: ""});
  const [groupError, setGroupError] = useState<string | null>(null);

  // 详情面板始终显示当前展开分类下的账号；选中 id 被过滤掉时回退到第一个可见账号。
  const user = visibleUser;

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
    const username = newUsername.trim();
    const email = newEmail.trim();
    const password = newPassword;
    if (!name || !username) {
      showToast(t("errors.rbac.invalidNewUser"), "error");
      return;
    }
    // Mirrors the endpoint's checks so the visitor gets the verdict before a
    // round trip; the server re-checks regardless. An empty address is allowed
    // — the account then signs in with its username alone.
    if (validateAdminUsername(username)) {
      showToast(t("errors.rbac.invalidUsername"), "error");
      return;
    }
    if (email) {
      if (validateAdminEmail(email)) {
        showToast(t("errors.rbac.invalidEmail"), "error");
        return;
      }
      if (isReservedAdminEmailDomain(email)) {
        showToast(t("errors.rbac.reservedEmailDomain"), "error");
        return;
      }
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
        body: JSON.stringify({email, name, password, roles: newRoles, username}),
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
      setNewUsername("");
      setNewEmail("");
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
    const banned = !user.banned;
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxRbacUserBan(), {
        body: JSON.stringify({banned, userId: user.id}),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      if (!response.ok) {
        showToast(await parseError(response, t("errors.rbac.banUserFailed")), "error");
        return;
      }
      setBoard(await response.json() as RbacUserBoard);
      // 解封只把标志置回：封禁时吊销的登录凭据不会自动复活，得如实告诉操作者，
      // 否则下一句就是「解封了怎么还是登不上」。
      showToast(
        banned ? t("rbac.accountBanDone") : t("rbac.accountUnbanDone"),
        "success",
      );
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

  const startEditName = () => {
    if (!user) return;
    setNameDraft(user.name);
    setEditingName(true);
  };

  const saveName = async () => {
    if (!user) return;
    const name = nameDraft.trim();
    if (!name) {
      showToast(t("errors.rbac.invalidName"), "error");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxRbacUserProfile(), {
        body: JSON.stringify({name, userId: user.id}),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      if (!response.ok) {
        showToast(
          await parseError(response, t("errors.rbac.profileUpdateFailed")),
          "error",
        );
        return;
      }
      setBoard(await response.json() as RbacUserBoard);
      setEditingName(false);
      setNameDraft("");
      showToast(t("rbac.nameSaved"), "success");
    } catch {
      showToast(t("errors.rbac.profileUpdateFailed"), "error");
    } finally {
      setSaving(false);
    }
  };

  const startEditEmail = () => {
    if (!user) return;
    setEmailDraft(user.email);
    setEditingEmail(true);
  };

  const saveEmail = async () => {
    if (!user) return;
    const email = normalizeAdminEmail(emailDraft);
    if (validateAdminEmail(email)) {
      showToast(t("errors.rbac.invalidEmail"), "error");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxRbacUserProfile(), {
        body: JSON.stringify({email, userId: user.id}),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      if (!response.ok) {
        showToast(
          await parseError(response, t("errors.rbac.profileUpdateFailed")),
          "error",
        );
        return;
      }
      setBoard(await response.json() as RbacUserBoard);
      setEditingEmail(false);
      setEmailDraft("");
      showToast(t("rbac.emailSaved"), "success");
    } catch {
      showToast(t("errors.rbac.profileUpdateFailed"), "error");
    } finally {
      setSaving(false);
    }
  };

  /**
   * Give an account created before the username column existed a username. The
   * endpoint refuses when one is already set, so this control only ever shows
   * for accounts that still have none.
   */
  const saveUsername = async () => {
    if (!user) return;
    const username = usernameDraft.trim();
    if (validateAdminUsername(username)) {
      showToast(t("errors.rbac.invalidUsername"), "error");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxRbacUserProfile(), {
        body: JSON.stringify({userId: user.id, username}),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      if (!response.ok) {
        showToast(
          await parseError(response, t("errors.rbac.profileUpdateFailed")),
          "error",
        );
        return;
      }
      setBoard(await response.json() as RbacUserBoard);
      setEditingUsername(false);
      setUsernameDraft("");
      showToast(t("rbac.usernameSaved"), "success");
    } catch {
      showToast(t("errors.rbac.profileUpdateFailed"), "error");
    } finally {
      setSaving(false);
    }
  };

  const savePassword = async () => {
    if (!user) return;
    if (validateAdminPassword(newPw)) {
      showToast(
        t("errors.password.policy", {min: MIN_ADMIN_PASSWORD_LENGTH}),
        "error",
      );
      return;
    }
    if (newPw !== confirmPw) {
      showToast(t("rbac.passwordsMustMatch"), "error");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxRbacUserPasswordReset(), {
        body: JSON.stringify({newPassword: newPw, userId: user.id}),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      if (!response.ok) {
        showToast(
          await parseError(response, t("errors.rbac.passwordResetFailed")),
          "error",
        );
        return;
      }
      setBoard(await response.json() as RbacUserBoard);
      setResetOpen(false);
      setNewPw("");
      setConfirmPw("");
      showToast(t("rbac.passwordResetSuccess"), "success");
    } catch {
      showToast(t("errors.rbac.passwordResetFailed"), "error");
    } finally {
      setSaving(false);
    }
  };

  /** 单账号的注册来源：下拉即改即存，改完这个账号就落到另一个分组里。 */
  const saveSignupSource = async (source: string) => {
    if (!user || source === user.signupSource) return;
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxRbacUserProfile(), {
        body: JSON.stringify({signupSource: source, userId: user.id}),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      if (!response.ok) {
        showToast(
          await parseError(response, t("errors.rbac.profileUpdateFailed")),
          "error",
        );
        return;
      }
      setBoard(await response.json() as RbacUserBoard);
      showToast(t("rbac.signupSourceSaved"), "success");
    } catch {
      showToast(t("errors.rbac.profileUpdateFailed"), "error");
    } finally {
      setSaving(false);
    }
  };

  // ---- 分组维护（`settings` 的 signup_sources） ----

  const openGroupManager = () => {
    setDraftSources(signupSources.map((option) => ({...option})));
    setNewSource({label: "", value: ""});
    setGroupError(null);
    setGroupOpen(true);
  };

  const updateDraftLabel = (index: number, label: string) => {
    setDraftSources((previous) =>
      previous.map((option, at) => (at === index ? {...option, label} : option)));
  };

  const removeDraft = (index: number) => {
    setDraftSources((previous) => previous.filter((_, at) => at !== index));
  };

  /** 新增一行草稿：先本地校验，通过才并入，失败给出对应文案。 */
  const addDraft = () => {
    const value = newSource.value.trim();
    const label = newSource.label.trim();
    // 值的合法性与重复判定都走 shared 的同一份实现（系统分组也在那里被排除）。
    if (!isValidSignupSourceValue(value)) {
      setGroupError("rbac.userGroupValueInvalid");
      return;
    }
    if (!label) {
      setGroupError("rbac.userGroupLabelInvalid");
      return;
    }
    if (hasSignupSource(draftSources, value)) {
      setGroupError("rbac.userGroupDuplicated");
      return;
    }
    setDraftSources((previous) => [...previous, {label, value}]);
    setNewSource({label: "", value: ""});
    setGroupError(null);
  };

  /** 保存：整表覆盖写 settings，成功后用服务端返回的列表刷新左栏与下拉。 */
  const saveDraft = async () => {
    if (draftSources.length === 0) {
      setGroupError("rbac.userGroupRequired");
      return;
    }
    if (draftSources.some((option) => !option.label.trim())) {
      setGroupError("rbac.userGroupLabelInvalid");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxSignupSources(), {
        body: JSON.stringify({sources: draftSources}),
        headers: {"content-type": "application/json"},
        method: "PUT",
      });
      if (!response.ok) {
        showToast(await parseError(response, t("rbac.userGroupSaveFailed")), "error");
        return;
      }
      const data = (await response.json()) as {sources: SignupSourceOption[]};
      setSignupSources(data.sources);
      setGroupOpen(false);
      setGroupError(null);
      showToast(t("rbac.userGroupSaved"), "success");
    } catch {
      showToast(t("rbac.userGroupSaveFailed"), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <nav className="w-full shrink-0 rounded-[14px] border bg-card p-2 shadow-xs lg:w-72">
        <div className="p-1">
          <Input
            aria-label={t("rbac.userCategorySearch")}
            className="w-full"
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("rbac.userCategorySearchPlaceholder")}
            value={search}
          />
        </div>
        <div className="flex items-center gap-2 px-1 pb-2">
          <Button
            disabled={searchActive}
            onClick={collapseAll}
            size="sm"
            type="button"
            variant="outline"
          >
            {t("rbac.userCategoryCollapseAll")}
          </Button>
          <span className="flex-1" />
          <Button
            disabled={saving}
            onClick={openGroupManager}
            size="sm"
            type="button"
            variant="outline"
          >
            <PlusIcon aria-hidden="true" />
            {t("rbac.userCategoryCreateGroup")}
          </Button>
        </div>

        {/* 左栏分组树（CONTEXT.md「分组树」）：分组、计数与成员过滤都在本组件
            算好传入；手风琴单展开、搜索强制展开有命中的分组、换组自动选中首行
            都由上面的状态与回调表达，AdminGroupTree 只渲染传入状态。 */}
        <AdminGroupTree
          emptyLeafText={t("rbac.userGroupEmpty")}
          emptyTreeText={searchActive ? t("rbac.userCategoryNoResults") : undefined}
          expandedKeys={
            searchActive
              ? categoryList.filter((category) => categoryVisibleUsers(category).length > 0)
              : openCategory
                ? [openCategory]
                : []
          }
          groups={categoryList.map((category) => ({
            count: categoryUsers(category).length,
            key: category,
            label: categoryLabel(category),
            leaves: categoryVisibleUsers(category).map((entry) => ({
              description: entry.name
                ? `${entry.email} · ${entry.roles.length}`
                : String(entry.roles.length),
              id: entry.id,
              label: entry.name || entry.email,
            })),
          }))}
          onSelectLeaf={setSelectedId}
          onToggleGroup={toggleCategory}
          root={{
            count: board.users.length,
            icon: (
              <UsersIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            ),
            label: t("rbac.userCategoryAll"),
          }}
          selectedLeafId={selectedId}
        />

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
                aria-label={t("rbac.username")}
                disabled={saving}
                onChange={(event) => setNewUsername(event.target.value)}
                placeholder={t("rbac.username")}
                type="text"
                value={newUsername}
              />
              <Input
                aria-label={t("rbac.accountEmail")}
                disabled={saving}
                onChange={(event) => setNewEmail(event.target.value)}
                placeholder={t("rbac.accountEmail")}
                type="text"
                value={newEmail}
              />
              <p className="text-xs text-muted-foreground">
                {t("rbac.accountEmailHint")}
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
                    setNewUsername("");
                    setNewEmail("");
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
                setNewUsername("");
                setNewEmail("");
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
                {user.username && (
                  <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                    {t("rbac.username")}: {user.username}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button disabled={saving} onClick={save} size="sm" type="button">
                  {saving ? t("rbac.saving") : t("rbac.saveUserRoles")}
                </Button>
                <Button
                  disabled={saving}
                  onClick={() => setResetOpen(true)}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  {t("rbac.resetPassword")}
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
                <dt>{t("rbac.accountState")}</dt>
                <dd className={cn("font-mono", user.banned ? "text-amber-600 dark:text-amber-300" : "text-foreground")}>
                  {user.banned ? t("rbac.accountBanned") : t("rbac.accountActive")}
                </dd>
              </div>
            </dl>

            {/* 注册来源：改它就等于把这个账号挪到另一个分组，所以即改即存。 */}
            <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
              <span className="w-20 shrink-0 text-xs text-muted-foreground">
                {t("rbac.signupSource")}
              </span>
              <div className="w-56">
                <AdminSelect
                  ariaLabel={t("rbac.signupSource")}
                  disabled={saving}
                  onChange={(option) => void saveSignupSource(option.value)}
                  options={signupSources.map((option) => ({
                    label: option.label,
                    value: option.value,
                  }))}
                  value={
                    signupSources.find((option) => option.value === user.signupSource) ?? null
                  }
                />
              </div>
            </div>

            <div className="mb-4 flex flex-col gap-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-20 shrink-0 text-xs text-muted-foreground">
                  {t("rbac.accountName")}
                </span>
                {editingName ? (
                  <>
                    <Input
                      aria-label={t("rbac.accountName")}
                      className="h-8 w-56"
                      disabled={saving}
                      onChange={(event) => setNameDraft(event.target.value)}
                      value={nameDraft}
                    />
                    <Button
                      disabled={saving}
                      onClick={saveName}
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
                    <span className="font-mono text-foreground">{user.name}</span>
                    <Button
                      disabled={saving}
                      onClick={startEditName}
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
                  {t("rbac.email")}
                </span>
                {editingEmail ? (
                  <>
                    <Input
                      aria-label={t("rbac.email")}
                      className="h-8 w-56"
                      disabled={saving}
                      onChange={(event) => setEmailDraft(event.target.value)}
                      type="email"
                      value={emailDraft}
                    />
                    <Button
                      disabled={saving}
                      onClick={saveEmail}
                      size="xs"
                      type="button"
                    >
                      {t("common.save")}
                    </Button>
                    <Button
                      disabled={saving}
                      onClick={() => {
                        setEditingEmail(false);
                        setEmailDraft("");
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
                    <span className="font-mono text-foreground">{user.email}</span>
                    <Button
                      disabled={saving}
                      onClick={startEditEmail}
                      size="xs"
                      type="button"
                      variant="ghost"
                    >
                      {t("rbac.editEmail")}
                    </Button>
                  </>
                )}
              </div>
              {/* Accounts created before the username column existed have no
                  username; they can be given one, once. */}
              {!user.username && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-20 shrink-0 text-xs text-muted-foreground">
                    {t("rbac.username")}
                  </span>
                  {editingUsername ? (
                    <>
                      <Input
                        aria-label={t("rbac.username")}
                        className="h-8 w-56"
                        disabled={saving}
                        onChange={(event) => setUsernameDraft(event.target.value)}
                        type="text"
                        value={usernameDraft}
                      />
                      <Button
                        disabled={saving}
                        onClick={saveUsername}
                        size="xs"
                        type="button"
                      >
                        {t("common.save")}
                      </Button>
                      <Button
                        disabled={saving}
                        onClick={() => {
                          setEditingUsername(false);
                          setUsernameDraft("");
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
                      <span className="font-mono text-muted-foreground">—</span>
                      <Button
                        disabled={saving}
                        onClick={() => {
                          setUsernameDraft("");
                          setEditingUsername(true);
                        }}
                        size="xs"
                        type="button"
                        variant="ghost"
                      >
                        {t("rbac.setUsername")}
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>

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

            {resetOpen && (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
                onClick={() => setResetOpen(false)}
              >
                <div
                  className="w-full max-w-sm rounded-[14px] border bg-card p-5 shadow-lg"
                  onClick={(event) => event.stopPropagation()}
                >
                  <h3 className="font-semibold text-foreground">
                    {t("rbac.resetPasswordTitle")}
                  </h3>
                  <p className="mt-1 mb-3 text-xs text-muted-foreground">
                    {t("rbac.resetPasswordDescription")}
                  </p>
                  <label className="block text-xs text-muted-foreground">
                    {t("rbac.newPassword")}
                  </label>
                  <Input
                    aria-label={t("rbac.newPassword")}
                    className="mt-1"
                    disabled={saving}
                    onChange={(event) => setNewPw(event.target.value)}
                    type="password"
                    value={newPw}
                  />
                  <label className="mt-3 block text-xs text-muted-foreground">
                    {t("rbac.confirmPassword")}
                  </label>
                  <Input
                    aria-label={t("rbac.confirmPassword")}
                    className="mt-1"
                    disabled={saving}
                    onChange={(event) => setConfirmPw(event.target.value)}
                    type="password"
                    value={confirmPw}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("rbac.passwordHint", {min: MIN_ADMIN_PASSWORD_LENGTH})}
                  </p>
                  <div className="mt-4 flex justify-end gap-2">
                    <Button
                      disabled={saving}
                      onClick={() => setResetOpen(false)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button
                      disabled={saving}
                      onClick={savePassword}
                      size="sm"
                      type="button"
                    >
                      {t("rbac.resetPassword")}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t("rbac.noUsers")}</p>
        )}
      </section>

      {/* 分组维护弹层：与账号详情无关，挂在页面层，未选中账号时也能打开。 */}
      <AdminDialog
        onOpenChange={(next) => {
          if (!next) setGroupOpen(false);
        }}
        open={groupOpen}
        title={t("rbac.userGroupTitle")}
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            {t("rbac.userGroupDescription")}
          </p>
          <p className="rounded-md border bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
            {t("rbac.userGroupBannedNote")}
          </p>

          <div className="grid grid-cols-[7rem_1fr_auto] items-center gap-2 text-xs">
            <span className="text-muted-foreground">
              {t("rbac.userGroupValueColumn")}
            </span>
            <span className="text-muted-foreground">
              {t("rbac.userGroupLabelColumn")}
            </span>
            <span />
            {draftSources.map((option, index) => {
              // 建号链路把这三个 value 写死在 SQL 里，删了会让下一次注册造出
              // 列表外的值；服务端也会拒，这里先把入口关掉。
              const builtin = BUILTIN_SIGNUP_SOURCES.includes(option.value);
              return (
                <Fragment key={option.value}>
                  <code className="truncate font-mono text-foreground">
                    {option.value}
                    {builtin && (
                      <span className="ml-1 text-muted-foreground" title={t("rbac.userGroupBuiltinLocked")}>
                        *
                      </span>
                    )}
                  </code>
                  <Input
                    aria-label={t("rbac.userGroupLabelColumn")}
                    className="h-8"
                    disabled={saving}
                    onChange={(event) => updateDraftLabel(index, event.target.value)}
                    value={option.label}
                  />
                  <Button
                    aria-label={t("rbac.userGroupRemove")}
                    disabled={saving || builtin}
                    onClick={() => removeDraft(index)}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2Icon aria-hidden="true" />
                  </Button>
                </Fragment>
              );
            })}
          </div>

          <div className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
            <Input
              aria-label={t("rbac.userGroupValueColumn")}
              className="h-8"
              disabled={saving}
              onChange={(event) =>
                setNewSource((previous) => ({...previous, value: event.target.value}))}
              placeholder={t("rbac.userGroupValuePlaceholder")}
              value={newSource.value}
            />
            <Input
              aria-label={t("rbac.userGroupLabelColumn")}
              className="h-8"
              disabled={saving}
              onChange={(event) =>
                setNewSource((previous) => ({...previous, label: event.target.value}))}
              placeholder={t("rbac.userGroupLabelPlaceholder")}
              value={newSource.label}
            />
            <Button
              disabled={saving}
              onClick={addDraft}
              size="xs"
              type="button"
              variant="outline"
            >
              {t("rbac.userGroupAdd")}
            </Button>
          </div>

          {groupError && (
            <p className="text-xs text-destructive">{t(groupError)}</p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              disabled={saving}
              onClick={() => setGroupOpen(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={saving}
              onClick={saveDraft}
              size="sm"
              type="button"
            >
              {t("common.save")}
            </Button>
          </div>
        </div>
      </AdminDialog>
    </div>
  );
}
