/**
 * One RBAC audit-trail row, shaped for the admin page.
 *
 * Lives in `shared/` rather than `server/` so the React island can import it:
 * browser code must not reach into `@/server/` (see
 * `tests/unit/source-architecture.test.ts`). `readRecentRbacAudit` maps its
 * query result onto this shape.
 */
export interface RbacAuditRow {
  id: string;
  actorLabel: string | null;
  /** A stable dotted verb: `role.create`, `user.ban`, … */
  action: string;
  /** What was changed: a role code, an account id, a device id. */
  target: string;
  /** The new value, or anything else worth keeping. */
  detail: string | null;
  /** What the value was before, where that is meaningful (grant lists). */
  beforeDetail: string | null;
  createdAtMs: number;
}

/**
 * Every action code the trail writes — the single source for the audit board's
 * "known action" set. `rbac-handlers.ts` (the writer) and the i18n
 * `rbacAudit.actionLabel.*` tree must stay in step with it. `RbacAuditRow.action`
 * stays a plain string: it is read straight from the database, so a union here
 * would be a lie the moment a newer writer lands a code this list doesn't know.
 */
export const RBAC_AUDIT_ACTIONS = [
  "role.create",
  "role.rename",
  "role.renameCode",
  "role.delete",
  "role.permissions",
  "role.login",
  "role.member",
  "user.create",
  "user.delete",
  "user.ban",
  "user.unban",
  "user.passwordReset",
  "user.profile",
  "user.roles",
  "device.revoke",
  "device.restore",
  "credential.create",
  "credential.revoke",
] as const;
