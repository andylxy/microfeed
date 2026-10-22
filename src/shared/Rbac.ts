/**
 * Shared RBAC administration shapes.
 *
 * These live outside `src/server/` because the dashboard component reads them
 * too, and browser code must not import from the Worker layer (enforced by
 * `tests/unit/source-architecture.test.ts`).
 */

import {adminMenuItemLabel} from "./AdminNavigation";
import type {AdminLanguage} from "./AdminLanguage";

/**
 * Role a newly created account receives when the operator ticks none. Kept in
 * shared code because both the create endpoint (server) and the create form
 * (browser) need the same default; it must match the role seeded by migration
 * 0043 and `RBAC_ROLES` in `src/server/rbac/seed.ts`.
 */
export const DEFAULT_USER_ROLE = "readonly";

/**
 * The `auth_user.role` value that lets an account call Better Auth's own admin
 * plugin endpoints (set-role, ban-user, remove-user, impersonate-user, …).
 *
 * Those endpoints gate on `auth_user.role`, not on RBAC, so this field is the
 * second authorization source. It is therefore treated as a **derived mirror**
 * of holding the RBAC `super_admin` role — `replaceUserRoles` and migration
 * 0053 keep the two in step — and never as an independent grant.
 */
export const BETTER_AUTH_ADMIN_ROLE = "admin";

/** The `auth_user.role` value of an account that may not call the admin plugin. */
export const BETTER_AUTH_USER_ROLE = "user";

/**
 * 权限对象的终端归属（ADR-0039 D1）：
 *   - `desktop` —— 后台页面权限（内容 / 审核 / 站点 / 集成 / 账户 / 运营）；
 *   - `app` —— App 能力权限码（`app:nav:read` / `app:version:read` / …）。
 *
 * 两个控制台按这一维互斥分区：PC 端管理只看 `desktop`，App 端管理只看 `app`。
 * 判定点不少（授权视图组装、授权保存、权限树三端点、新节点继承），判定入口
 * 收在这里（`isPermissionAudience` 校验入参，`audienceOf` 由叶子推码的归属），
 * 调用方传的是这个类型，不再各处自写判定。
 */
export type PermissionAudience = "desktop" | "app";

/** 入参是否为合法终端归属；非法值一律 fail-closed 由调用方返回 400。 */
export function isPermissionAudience(value: unknown): value is PermissionAudience {
  return value === "desktop" || value === "app";
}

export interface RbacBoardRole {
  /**
   * 该角色是否允许登录后台（`ext_roles.allow_admin_login`）。账号同时持有多个
   * 角色时取并集：任一角色允许即可进入；关闭只影响后台入口，不动授权行。
   */
  allowAdminLogin: boolean;
  code: string;
  /**
   * 该角色是否为会员（`ext_roles.is_member`，migration 0144）。鉴权时并入
   * `locals.appMember`，决定 App 端点（GetNav / 章节正文等）的内容档；新建角色默认 false。
   */
  isMember: boolean;
  name: string;
  permissions: string[];
}

export interface RbacBoard {
  /**
   * 这一板属于哪一端（ADR-0039）：PC 端管理读 `desktop`，App 端管理读 `app`。
   * 前端保存授权时原样回传，服务端据此校验提交的码是否都属于本端。
   */
  audience: PermissionAudience;
  /**
   * 角色编辑器渲染的那棵树：分组行 → 页面行 → 每页管的那些码。服务端从
   * 自持的 `ext_permission_nodes` 行拼出来（ADR-0038）：分组是 `parent_code`
   * 为空的行，页面是它下面的页面行，码是每个页面下的叶子行。
   */
  groups: RbacPermissionGroup[];
  permissions: {code: string; name: string}[];
  roles: RbacBoardRole[];
}

/** One account, with the roles granted to it through `ext_user_roles`. */
export interface RbacUser {
  banned: boolean;
  email: string;
  id: string;
  /** `auth_user.role`, the Better Auth string role that predates RBAC. */
  legacyRole: string | null;
  name: string;
  roles: string[];
  /**
   * Login username, present only for username accounts (email accounts have
   * none). `display_username` is preferred (keeps the original case), falling
   * back to the normalized `username`; read-only in the UI.
   */
  username?: string;
}

export interface RbacUserBoard {
  roles: {code: string; name: string}[];
  users: RbacUser[];
}

/** 角色编辑器树里的一行页面。 */
export interface RbacPermissionPage {
  /**
   * 页面节点的码：把 `page_` 前缀去掉的部分（如 `books`），或 App 能力页的码
   * （如 `app_version_read`）。每个码都挂在一个明确的页面下；原先那个合成
   * 兜底页如今只是一条普通的种子行（`page_unmapped`）。
   */
  code: string;
  /** 本页管辖的权限码，已排序。 */
  codes: string[];
  /** 节点行的双语名（种子行入库时写入，自建行由管理页维护）。 */
  nameEn?: string | null;
  nameZh?: string | null;
  /** 双语名全空时的 i18n 兜底键（自建分组为 `rbac.node.<code>`）。 */
  i18nKey?: string | null;
}

/** 角色编辑器树里的一行分组。 */
export interface RbacPermissionGroup {
  /** 分组节点的码（如 `group_content`）。 */
  code: string;
  /** 节点行的双语名，见 {@link RbacPermissionPage}。 */
  nameEn?: string | null;
  nameZh?: string | null;
  /** 节点行的 i18n 兜底键，见 {@link RbacPermissionPage}。 */
  i18nKey?: string | null;
  pages: RbacPermissionPage[];
}

/**
 * 授权树组/页与权限树节点行共用的标签解析形状：code + 双语名 + i18n 兜底键。
 * 两棵树的标签解析走同一份逻辑，显示口径不漂移。
 */
export interface RbacTreeLabelEntry {
  code: string;
  i18nKey?: string | null;
  nameEn?: string | null;
  nameZh?: string | null;
}

/**
 * 授权树标签：当前语言的双语名优先（空列取另一列），双名全空时走 i18n
 * 兜底键，键也不存在时显示 code 本身。`t` 由调用方传入（与
 * `menuRowEffectiveLabel` 同款，避免依赖 i18n 初始化时序）。
 */
export function rbacTreeLabel(
  entry: RbacTreeLabelEntry,
  language: AdminLanguage,
  t: (key: string, options?: {defaultValue: string}) => string,
): string {
  const named = adminMenuItemLabel(
    {en: entry.nameEn ?? "", zh: entry.nameZh ?? ""},
    language,
  );
  if (named) return named;
  if (entry.i18nKey) {
    const fallback = t(entry.i18nKey, {defaultValue: entry.code}).trim();
    if (fallback) return fallback;
  }
  return entry.code;
}

/**
 * The granted set after toggling a branch: `checked` grants every code in the
 * branch, otherwise they are all revoked. A leaf passes a single code.
 */
export function togglePermissionBranch(
  granted: readonly string[],
  codes: readonly string[],
  checked: boolean,
): string[] {
  if (checked) return [...new Set([...granted, ...codes])].sort();
  const drop = new Set(codes);
  return granted.filter((code) => !drop.has(code));
}

/**
 * How a branch checkbox should render: fully `checked` when every code in the
 * branch is granted, `indeterminate` when only some are.
 */
export function permissionBranchState(
  codes: string[],
  granted: ReadonlySet<string>,
): {checked: boolean; indeterminate: boolean} {
  const hit = codes.filter((code) => granted.has(code)).length;
  return {
    checked: codes.length > 0 && hit === codes.length,
    indeterminate: hit > 0 && hit < codes.length,
  };
}
