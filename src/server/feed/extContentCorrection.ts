import {randomShortUUID} from "@/shared/StringUtils";
import {AppError} from "@/shared/errors";
import {
  computeDiff,
  countAuditRecords,
  shouldCheckpoint,
  AUDIT_CHECKPOINT_INTERVAL,
  type FieldChange,
} from "@/server/feed/extContentAudit";

/**
 * Content correction: the review flow that actually matches the requirement.
 *
 * Reviewing means checking what the READER PAGE renders. When a page is wrong,
 * the reviewer who owns that page submits a correction here; nothing touches
 * the item until someone confirms. Approving writes the proposed data back to
 * the ORIGINAL storage location (`items.data`) — not a draft row, not a shadow
 * copy — and leaves a trail answering who submitted, what changed, and who
 * approved.
 *
 * This is deliberately separate from `extContentAudit`: that table is an
 * append-only history of what happened, this one holds a *pending decision*.
 */

export type CorrectionStatus = "pending" | "approved" | "rejected";

export interface ContentCorrection {
  id: string;
  itemId: string;
  status: CorrectionStatus;
  changes: FieldChange[];
  submittedBy: string | null;
  submittedAt: number | null;
  reviewedBy: string | null;
  reviewedAt: number | null;
  reason: string | null;
}

/** Minimal D1-shaped database port, matching the other ext* modules. */
export interface CorrectionDbPreparedStatement {
  bind(...values: unknown[]): CorrectionDbPreparedStatement;
  run(): Promise<{success: boolean}>;
  all(): Promise<{results: Record<string, unknown>[]}>;
  first(): Promise<Record<string, unknown> | null>;
}

export interface CorrectionDb {
  prepare(query: string): CorrectionDbPreparedStatement;
}

export const CORRECTION_ERRORS = {
  invalidInput: "errors.corrections.invalidInput",
  itemNotFound: "errors.corrections.itemNotFound",
  notFound: "errors.corrections.notFound",
  notPending: "errors.corrections.notPending",
} as const;

function fail(key: string, status: number): AppError {
  return new AppError(key, status);
}

/** Same columns as `ext_content_audit` plus the approval linkage. */
const INSERT_AUDIT = `INSERT INTO ext_content_audit (
  id, item_id, channel_id, action, actor_type, actor_id,
  diff_data, checkpoint_data, is_checkpoint, review_status, reason,
  approved_by, approved_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toCorrection(row: Record<string, unknown>): ContentCorrection {
  return {
    changes: parseJson<FieldChange[]>(row.diff_data, []),
    id: String(row.id ?? ""),
    itemId: String(row.item_id ?? ""),
    reason: row.reason == null ? null : String(row.reason),
    reviewedAt: row.reviewed_at == null ? null : Number(row.reviewed_at),
    reviewedBy: row.reviewed_by == null ? null : String(row.reviewed_by),
    status: String(row.status ?? "pending") as CorrectionStatus,
    submittedAt: row.submitted_at == null ? null : Number(row.submitted_at),
    submittedBy: row.submitted_by == null ? null : String(row.submitted_by),
  };
}

async function readItemData(
  db: CorrectionDb,
  itemId: string,
): Promise<Record<string, unknown> | null> {
  const row = await db.prepare(
    "SELECT id, data FROM items WHERE id = ?",
  ).bind(itemId).first();
  if (!row) return null;
  return parseJson<Record<string, unknown>>(row.data, {});
}

/**
 * Propose a fix for one chapter. The item is NOT modified here — that only
 * happens in {@link approveCorrection}.
 *
 * A proposal that changes nothing is rejected: it would be an empty decision
 * with no "更新了什么" to show.
 */
export async function submitCorrection(
  db: CorrectionDb,
  params: {
    itemId: string;
    proposedData: Record<string, unknown>;
    submittedBy?: string | null;
    reason?: string | null;
  },
): Promise<ContentCorrection> {
  const {itemId, proposedData, submittedBy = null, reason = null} = params;
  if (!itemId || !proposedData) {
    throw fail(CORRECTION_ERRORS.invalidInput, 400);
  }
  const existing = await readItemData(db, itemId);
  if (!existing) throw fail(CORRECTION_ERRORS.itemNotFound, 404);

  const changes = computeDiff(existing, proposedData);
  if (changes.length === 0) {
    throw fail(CORRECTION_ERRORS.invalidInput, 400);
  }

  const id = randomShortUUID();
  const now = Date.now();
  await db.prepare(
    `INSERT INTO ext_content_correction (
      id, item_id, status, diff_data, proposed_data,
      submitted_by, submitted_at, reason
    ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    itemId,
    JSON.stringify(changes),
    JSON.stringify(proposedData),
    submittedBy,
    now,
    reason,
  ).run();

  return {
    changes,
    id,
    itemId,
    reason,
    reviewedAt: null,
    reviewedBy: null,
    status: "pending",
    submittedAt: now,
    submittedBy,
  };
}

export async function listCorrections(
  db: CorrectionDb,
  itemId: string,
): Promise<ContentCorrection[]> {
  const result = await db.prepare(
    "SELECT * FROM ext_content_correction WHERE item_id = ? " +
      "ORDER BY submitted_at ASC, rowid ASC",
  ).bind(itemId).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  return rows.map(toCorrection);
}

export async function getCorrection(
  db: CorrectionDb,
  id: string,
): Promise<ContentCorrection | null> {
  const row = await db.prepare(
    "SELECT * FROM ext_content_correction WHERE id = ?",
  ).bind(id).first();
  return row ? toCorrection(row) : null;
}

/**
 * Confirm the latest proposed modification and write it back to the ORIGINAL
 * storage location.
 *
 * Re-approving an already-decided proposal is refused: "是否同意更新最新修改"
 * is a decision about the current proposal, and silently re-applying an old one
 * would overwrite whatever landed since.
 */
export async function approveCorrection(
  db: CorrectionDb,
  id: string,
  reviewedBy: string | null,
): Promise<ContentCorrection> {
  const row = await db.prepare(
    "SELECT * FROM ext_content_correction WHERE id = ?",
  ).bind(id).first();
  if (!row) throw fail(CORRECTION_ERRORS.notFound, 404);
  if (String(row.status ?? "") !== "pending") {
    throw fail(CORRECTION_ERRORS.notPending, 409);
  }

  const itemId = String(row.item_id ?? "");
  const proposedData = parseJson<Record<string, unknown>>(row.proposed_data, {});
  const existing = await readItemData(db, itemId);
  if (!existing) throw fail(CORRECTION_ERRORS.itemNotFound, 404);

  const now = Date.now();
  const changes = computeDiff(existing, proposedData);

  // Write to the original storage location.
  await db.prepare(
    "UPDATE items SET data = ?, updated_at = ? WHERE id = ?",
  ).bind(
    JSON.stringify(proposedData),
    new Date(now).toISOString().replace("T", " ").slice(0, 19),
    itemId,
  ).run();

  // Trail: what changed, who submitted it, who approved it.
  const existingCount = await countAuditRecords(
    db as unknown as Parameters<typeof countAuditRecords>[0],
    itemId,
  );
  const isCheckpoint = shouldCheckpoint(existingCount, AUDIT_CHECKPOINT_INTERVAL);
  await db.prepare(INSERT_AUDIT).bind(
    randomShortUUID(),
    itemId,
    proposedData.channel_id ?? null,
    "correction_apply",
    "reviewer",
    reviewedBy,
    JSON.stringify(changes),
    isCheckpoint ? JSON.stringify(proposedData) : null,
    isCheckpoint ? 1 : 0,
    null,
    row.reason ?? null,
    reviewedBy,
    now,
  ).run();

  await db.prepare(
    "UPDATE ext_content_correction SET status = 'approved', " +
      "reviewed_by = ?, reviewed_at = ? WHERE id = ?",
  ).bind(reviewedBy, now, id).run();

  return {
    changes: parseJson<FieldChange[]>(row.diff_data, []),
    id,
    itemId,
    reason: row.reason == null ? null : String(row.reason),
    reviewedAt: now,
    reviewedBy,
    status: "approved",
    submittedAt: row.submitted_at == null ? null : Number(row.submitted_at),
    submittedBy: row.submitted_by == null ? null : String(row.submitted_by),
  };
}

/** Reject a proposal. The item is left exactly as it was. */
export async function rejectCorrection(
  db: CorrectionDb,
  id: string,
  reviewedBy: string | null,
): Promise<ContentCorrection> {
  const row = await db.prepare(
    "SELECT * FROM ext_content_correction WHERE id = ?",
  ).bind(id).first();
  if (!row) throw fail(CORRECTION_ERRORS.notFound, 404);
  if (String(row.status ?? "") !== "pending") {
    throw fail(CORRECTION_ERRORS.notPending, 409);
  }
  const now = Date.now();
  await db.prepare(
    "UPDATE ext_content_correction SET status = 'rejected', " +
      "reviewed_by = ?, reviewed_at = ? WHERE id = ?",
  ).bind(reviewedBy, now, id).run();
  return {
    changes: parseJson<FieldChange[]>(row.diff_data, []),
    id,
    itemId: String(row.item_id ?? ""),
    reason: row.reason == null ? null : String(row.reason),
    reviewedAt: now,
    reviewedBy,
    status: "rejected",
    submittedAt: row.submitted_at == null ? null : Number(row.submitted_at),
    submittedBy: row.submitted_by == null ? null : String(row.submitted_by),
  };
}
