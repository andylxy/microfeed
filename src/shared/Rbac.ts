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
