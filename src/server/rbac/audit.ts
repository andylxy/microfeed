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
 *
 * A few mutations go through Better Auth's admin plugin rather than our own
 * writes and cannot share a batch with us; they use {@link recordRbacAudit} as a
 * separate statement. Every one of them is idempotent, so a retry after a
 * failure re-applies it harmlessly and writes the row.
 */

import {env} from "cloudflare:workers";

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

export function auditStatement(
  db: D1Database,
  entry: PendingAudit,
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO ext_rbac_audit " +
        "(id, actor_user_id, actor_label, action, target, detail, " +
        "before_detail, created_at_ms) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      crypto.randomUUID(),
      entry.actor?.id ?? null,
      entry.actor?.email ?? entry.actor?.name ?? null,
      entry.action,
      entry.target,
      entry.detail ?? null,
      entry.before ?? null,
      Date.now(),
    );
}

/**
 * Write the row on its own — only for mutations that cannot share a batch with
 * the trail (those that go through Better Auth's admin plugin).
 */
export async function recordRbacAudit(entry: PendingAudit): Promise<void> {
  await auditStatement(env.FEED_DB, entry).run();
}
