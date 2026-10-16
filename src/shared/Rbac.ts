/**
 * Shared RBAC administration shapes.
 *
 * These live outside `src/server/` because the dashboard component reads them
 * too, and browser code must not import from the Worker layer (enforced by
 * `tests/unit/source-architecture.test.ts`).
 */

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

export interface RbacBoardRole {
  code: string;
  name: string;
  permissions: string[];
}

export interface RbacBoard {
  /**
   * The permission tree the role editor renders: menu groups -> menu pages ->
   * the codes each page governs. Built server-side from `ext_menu`,
   * `ext_menu_permissions` and the catalogue.
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

/** One menu page in the role editor's tree. */
export interface RbacPermissionPage {
  /**
   * The menu code (e.g. `books`), a synthetic App 能力页 code (e.g.
   * `app_version_read`), or `unmapped` for the catch-all page.
   */
  code: string;
  /** The permission codes this page governs, sorted. */
  codes: string[];
}

/** One menu group in the role editor's tree. */
export interface RbacPermissionGroup {
  /** The menu group code (e.g. `group_content`), or `group_other`. */
  code: string;
  pages: RbacPermissionPage[];
}

/** Everything the tree is derived from. */
export interface RbacPermissionTreeInput {
  /** Menu groups in display order, each with its page codes. */
  menu: {code: string; pages: string[]}[];
  /** Page code -> permission codes (the `ext_menu_permissions` rows). */
  mapping: Record<string, string[]>;
  /** The permission catalogue. */
  permissions: {code: string; name: string}[];
}

/** Catch-all group / page for codes no menu page maps to. */
export const RBAC_OTHER_GROUP = "group_other";
export const RBAC_OTHER_PAGE = "unmapped";
/** Synthetic page for the App 名词解释查看权限 (`app:mingci:*`); lives inside {@link RBAC_OTHER_GROUP}. */
export const RBAC_MINGCI_PAGE = "mingci";
/** Synthetic page for the App 版本升级读取权限 (`app:version:*`); lives inside {@link RBAC_OPERATIONS_GROUP}. */
export const RBAC_VERSION_PAGE = "app_version_read";
/** Synthetic page for the App 运营公告读取权限 (`app:announcement:*`); lives inside {@link RBAC_OPERATIONS_GROUP}. */
export const RBAC_ANNOUNCEMENT_PAGE = "app_announcement_read";
/** 运营管理菜单组 code（migrations/0089 建立）。 */
export const RBAC_OPERATIONS_GROUP = "group_operations";

/**
 * Prefix routing table for unmapped App 能力权限：按 code 前缀把 unmapped 桶
 * 分流到独立的合成 page 上，避免 `unmapped` 混装不相关的能力。加新 App 权限时
 * 在此表追加一行即可，无需改 `buildPermissionTree`。
 *
 * `group` 指定合成页并入的菜单组：`group_operations`（运营管理）下的 App 读码
 * 独立成页（与后台 `system:*:manage` 页面解耦、可独立勾选）；省略则落入
 * {@link RBAC_OTHER_GROUP} 兜底（如 mingci）。目标组不在菜单里时回落到兜底。
 * `labelKey` 是该合成页在角色编辑器里的 i18n 标签键（见 {@link syntheticPageLabelKey}）。
 */
const OTHER_PAGE_PREFIXES: readonly {
  code: string;
  prefix: string;
  group?: string;
  labelKey: string;
}[] = [
  {code: RBAC_MINGCI_PAGE, prefix: "app:mingci:", labelKey: "rbac.mingci"},
  {
    code: RBAC_VERSION_PAGE,
    prefix: "app:version:",
    group: RBAC_OPERATIONS_GROUP,
    labelKey: "rbac.app_version",
  },
  {
    code: RBAC_ANNOUNCEMENT_PAGE,
    prefix: "app:announcement:",
    group: RBAC_OPERATIONS_GROUP,
    labelKey: "rbac.app_announcement",
  },
];

/**
 * i18n label key for a synthetic App 能力页 code, or `null` when the code is
 * not a synthetic page. Lets the role editor map a synthetic page to its label
 * without a per-page switch — adding a new App 能力页 only touches
 * {@link OTHER_PAGE_PREFIXES} + the i18n files.
 */
export function syntheticPageLabelKey(code: string): string | null {
  return OTHER_PAGE_PREFIXES.find((entry) => entry.code === code)?.labelKey ?? null;
}

/**
 * Build the role editor's permission tree: menu groups -> menu pages -> the
 * permission codes each page governs.
 *
 * Group and page nodes are batch-selection units only; the codes are the real
 * grants. Codes no menu page maps to land in the {@link RBAC_OTHER_GROUP}
 * catch-all, so nothing assignable can become invisible. {@link OTHER_PAGE_PREFIXES}
 * routes specific App 能力权限 前缀到独立合成 page：`app:mingci:*` 留兜底组，
 * `app:version:*` / `app:announcement:*` 并入 {@link RBAC_OPERATIONS_GROUP}（运营管理），
 * 与后台 `system:*:manage` 页面解耦、可独立勾选；剩余留在 {@link RBAC_OTHER_PAGE}。
 * The wildcard is dropped: it means "everything", so making it tickable here
 * would turn an ordinary role into a super administrator.
 */
export function buildPermissionTree(
  input: RbacPermissionTreeInput,
): RbacPermissionGroup[] {
  const assignable = new Set(
    input.permissions
      .map((permission) => permission.code)
      .filter((code) => code !== "*"),
  );

  const mapped = new Set<string>();
  const groups: RbacPermissionGroup[] = [];
  for (const group of input.menu) {
    const pages: RbacPermissionPage[] = [];
    for (const page of group.pages) {
      const codes = [...new Set(input.mapping[page] ?? [])]
        .filter((code) => assignable.has(code))
        .sort();
      if (codes.length === 0) continue;
      for (const code of codes) mapped.add(code);
      pages.push({code: page, codes});
    }
    if (pages.length > 0) groups.push({code: group.code, pages});
  }

  const unmapped = [...assignable].filter((code) => !mapped.has(code)).sort();
  if (unmapped.length > 0) {
    const otherPages: RbacPermissionPage[] = [];
    const routed = new Set<string>();
    for (const {code: pageCode, prefix, group} of OTHER_PAGE_PREFIXES) {
      const codes = unmapped.filter((c) => c.startsWith(prefix)).sort();
      if (codes.length === 0) continue;
      for (const c of codes) routed.add(c);
      const page: RbacPermissionPage = {code: pageCode, codes};
      // 指定了目标菜单组且不是兜底组时，把合成页并入该组（如 app:version:* →
      // 运营管理）；目标组不在菜单里则回落 group_other 兜底。
      const target =
        group && group !== RBAC_OTHER_GROUP
          ? groups.find((g) => g.code === group)
          : undefined;
      if (target) target.pages.push(page);
      else otherPages.push(page);
    }
    const remaining = unmapped.filter((c) => !routed.has(c));
    if (remaining.length > 0) otherPages.push({code: RBAC_OTHER_PAGE, codes: remaining});
    if (otherPages.length > 0) groups.push({code: RBAC_OTHER_GROUP, pages: otherPages});
  }

  return groups;
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
