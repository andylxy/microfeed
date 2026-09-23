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
}

export interface RbacUserBoard {
  roles: {code: string; name: string}[];
  users: RbacUser[];
}

/** One menu page in the role editor's tree. */
export interface RbacPermissionPage {
  /** The menu code (e.g. `books`), or `unmapped` for the catch-all page. */
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

/**
 * Build the role editor's permission tree: menu groups -> menu pages -> the
 * permission codes each page governs.
 *
 * Group and page nodes are batch-selection units only; the codes are the real
 * grants. Codes no menu page maps to land in the {@link RBAC_OTHER_GROUP}
 * catch-all, so nothing assignable can become invisible. The wildcard is
 * dropped: it means "everything", so making it tickable here would turn an
 * ordinary role into a super administrator.
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

  const other = [...assignable].filter((code) => !mapped.has(code)).sort();
  if (other.length > 0) {
    groups.push({
      code: RBAC_OTHER_GROUP,
      pages: [{code: RBAC_OTHER_PAGE, codes: other}],
    });
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
