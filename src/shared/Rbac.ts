/**
 * Shared RBAC administration shapes.
 *
 * These live outside `src/server/` because the dashboard component reads them
 * too, and browser code must not import from the Worker layer (enforced by
 * `tests/unit/source-architecture.test.ts`).
 */

export interface RbacBoardRole {
  code: string;
  name: string;
  permissions: string[];
}

export interface RbacBoard {
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
