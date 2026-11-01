/**
 * RBAC audit trail.
 *
 * Role and permission changes used to be invisible: nothing recorded who granted
 * what. Every mutation now carries one row, so "who gave this account that role?"
 * has an answer.
 *
 * The row is written **inside the same `db.batch()` as the change itself** (see
 * {@link auditStatement}), so the two either both land or neither does. That is
 * what makes it safe not to swallow errors: there is no window in which the
 * change committed but the trail did not, so AGENTS.md's fast-fail rule applies
 * with no caveat about retries.
 */

import type {RbacAuditRow} from "@/shared/RbacAudit";

/** The signed-in account, as far as the trail needs it. */
export interface AuditActor {
  email?: string | null;
  id?: string;
  name?: string | null;
}

/** One row, ready to be batched alongside the change it describes. */
export interface PendingAudit {
  actor?: AuditActor | null;
  /** A stable dotted verb: `role.create`, `user.ban`, … */
  action: string;
  /** What the value was before, where that is meaningful (grant lists). */
  before?: string;
  /** The new value, or anything else worth keeping. */
  detail?: string;
  /** What was changed: a role code, an account id, a device id. */
  target: string;
}

/** When set, the audit row lands only if this query returns at least one row.
 * Use it when the change riding the same batch is itself conditional, so a
 * skipped change does not leave a trail row describing a write that never
 * happened (B14: the per-user credential limit). */
export interface AuditOnlyIf {
  sql: string;
  binds?: unknown[];
}

export function auditStatement(
  db: D1Database,
  entry: PendingAudit,
  onlyIf?: AuditOnlyIf,
): D1PreparedStatement {
  const columns =
    "(id, actor_user_id, actor_label, action, target, detail, " +
    "before_detail, created_at_ms)";
  const sql = onlyIf
    ? `INSERT INTO ext_rbac_audit ${columns} ` +
      `SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${onlyIf.sql})`
    : `INSERT INTO ext_rbac_audit ${columns} ` +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
  return db
    .prepare(sql)
    .bind(
      crypto.randomUUID(),
      entry.actor?.id ?? null,
      entry.actor?.email ?? entry.actor?.name ?? null,
      entry.action,
      entry.target,
      entry.detail ?? null,
      entry.before ?? null,
      Date.now(),
      ...(onlyIf?.binds ?? []),
    );
}

/** The latest trail rows, newest first — read side for the admin page.
 * `RbacAuditRow` itself lives in `@/shared/RbacAudit` so the React island can
 * import it without reaching into `@/server/`. */
export async function readRecentRbacAudit(
  db: D1Database,
  limit = 100,
): Promise<RbacAuditRow[]> {
  const result = await db.prepare(
    "SELECT id, actor_label, action, target, detail, before_detail, created_at_ms " +
      "FROM ext_rbac_audit ORDER BY created_at_ms DESC, rowid DESC LIMIT ?",
  ).bind(limit).all<Record<string, unknown>>();
  return (result.results ?? []).map((row) => ({
    id: String(row.id ?? ""),
    actorLabel: row.actor_label == null ? null : String(row.actor_label),
    action: String(row.action ?? ""),
    target: String(row.target ?? ""),
    detail: row.detail == null ? null : String(row.detail),
    beforeDetail: row.before_detail == null ? null : String(row.before_detail),
    createdAtMs: Number(row.created_at_ms ?? 0),
  }));
}
