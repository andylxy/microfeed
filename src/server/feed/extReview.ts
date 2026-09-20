import {STATUSES} from "@/shared/Constants";

import {
  rebuildFromCheckpoint,
  type AuditDb,
  type FieldChange,
  type ItemData,
} from "./extContentAudit";

/**
 * Review state machine for the novel-cms extension.
 *
 * draft -> submitted -> approved | rejected, carried in the item's
 * `_microfeed.reviewStatus` pocket and mirrored into the `items.review_status`
 * column by FeedDb. Approval is the only transition that publishes; rejection
 * and takedown both unpublish.
 *
 * `reviewTransition` is pure so the rules can be tested without a database;
 * the rest of the module is the thin database side.
 */

export type ReviewStatus = "draft" | "submitted" | "approved" | "rejected";

export const REVIEW_STATUSES: readonly ReviewStatus[] = [
  "draft",
  "submitted",
  "approved",
  "rejected",
];

/**
 * Which review actions are legal from a given status. A transition missing from
 * this table is rejected, so a bad request cannot (for example) approve a raw
 * draft, or silently unpublish an approved chapter by re-submitting it.
 */
const REVIEW_TRANSITIONS: Readonly<Record<ReviewStatus, readonly ReviewAction[]>> = {
  draft: ["submit"],
  submitted: ["approve", "reject", "takedown"],
  approved: ["takedown"],
  rejected: ["submit", "takedown"],
};

/** True when `action` is a legal transition out of `from`. */
export function isAllowedReviewTransition(
  from: ReviewStatus,
  action: ReviewAction,
): boolean {
  return REVIEW_TRANSITIONS[from]?.includes(action) ?? false;
}

export type ReviewAction = "submit" | "approve" | "reject" | "takedown";

export interface ReviewTransition {
  reviewStatus: ReviewStatus;
  /** The item `status` the transition implies. */
  status: number;
  /** Reviewer's reason, kept on rejected/takedown rows. */
  reason: string | null;
  /** Set by takedown so the reading page can explain why a chapter vanished. */
  takedown: boolean;
}

/** The state a review action produces. Rejecting requires a reason. */
export function reviewTransition(
  action: ReviewAction,
  reason?: string | null,
): ReviewTransition {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  switch (action) {
    case "submit":
      return {
        reason: null,
        reviewStatus: "submitted",
        status: STATUSES.UNPUBLISHED,
        takedown: false,
      };
    case "approve":
      return {
        reason: null,
        reviewStatus: "approved",
        status: STATUSES.PUBLISHED,
        takedown: false,
      };
    case "reject":
      if (!trimmed) {
        throw new Error("extReview: rejecting a chapter requires a reason");
      }
      return {
        reason: trimmed,
        reviewStatus: "rejected",
        status: STATUSES.UNPUBLISHED,
        takedown: false,
      };
    case "takedown":
      return {
        reason: trimmed || null,
        reviewStatus: "rejected",
        status: STATUSES.UNPUBLISHED,
        takedown: true,
      };
  }
}

/** The review state carried in an item's `_microfeed` pocket. */
export function readItemReviewStatus(item: Record<string, unknown>): ReviewStatus {
  const microfeed = item._microfeed as Record<string, unknown> | undefined;
  const value = microfeed?.reviewStatus;
  return REVIEW_STATUSES.includes(value as ReviewStatus)
    ? (value as ReviewStatus)
    : "draft";
}

/** Apply a transition to a copy of the item's data. */
export function applyReviewTransition(
  data: ItemData,
  transition: ReviewTransition,
): ItemData {
  const microfeed = {...(data._microfeed as Record<string, unknown> | undefined)};
  microfeed.reviewStatus = transition.reviewStatus;
  if (transition.takedown) {
    microfeed.takedown = true;
    if (transition.reason) microfeed.takedownReason = transition.reason;
  } else {
    delete microfeed.takedown;
    delete microfeed.takedownReason;
  }
  if (transition.reason) {
    microfeed.reviewReason = transition.reason;
  } else {
    delete microfeed.reviewReason;
  }
  return {...data, _microfeed: microfeed};
}

/**
 * Merge a rebuilt historical version back onto the live item for a restore.
 *
 * The body (title/content and every `_microfeed.*` content field) comes from
 * `restored`, but the review *lifecycle* state is taken from the live
 * `existing` item: rolling a chapter back to an old body must not move it back
 * into the review queue, clear a takedown, or otherwise change where the
 * chapter currently sits in the workflow.
 */
export function mergeRestoredVersion(
  existing: ItemData,
  restored: ItemData,
): ItemData {
  const existingMicro = (existing._microfeed ?? {}) as Record<string, unknown>;
  const restoredMicro = (restored._microfeed ?? {}) as Record<string, unknown>;
  return {
    ...existing,
    ...restored,
    _microfeed: {
      ...restoredMicro,
      reviewStatus: (existingMicro.reviewStatus as string | undefined)
        ?? (restoredMicro.reviewStatus as string | undefined)
        ?? "draft",
      takedown: existingMicro.takedown ?? restoredMicro.takedown ?? false,
      takedownReason: existingMicro.takedownReason ?? restoredMicro.takedownReason ?? null,
    },
  };
}

export interface ReviewQueueRow {
  id: string;
  title: string;
  reviewStatus: string;
  updatedAt: string;
}

const SELECT_QUEUE = `SELECT id, data, review_status, updated_at
  FROM items WHERE review_status = 'submitted'
  ORDER BY updated_at ASC`;

/** Chapters waiting for review, oldest first. */
export async function listPendingReviewItems(
  db: AuditDb,
): Promise<ReviewQueueRow[]> {
  const result = await db.prepare(SELECT_QUEUE).all();
  return result.results.map((row) => {
    let title = "";
    try {
      const data = JSON.parse(String(row.data ?? "{}")) as Record<string, unknown>;
      title = String(data.title ?? "");
    } catch {
      // A malformed row should not break the whole queue; it shows up untitled.
    }
    return {
      id: String(row.id ?? ""),
      reviewStatus: String(row.review_status ?? ""),
      title,
      updatedAt: String(row.updated_at ?? ""),
    };
  });
}

export interface AuditRow {
  id: string;
  action: string;
  actorType: string;
  actorId: string | null;
  /** Hidden from the dashboard listing. The row itself is never deleted. */
  archived: boolean;
  diffData: FieldChange[];
  isCheckpoint: boolean;
  reviewStatus: string | null;
  reason: string | null;
  createdAt: string;
  /**
   * Whether this version can actually be restored. Replaying needs a full
   * snapshot at or before the row (ADR-0003), so rows recorded before the
   * item's first checkpoint can never be rebuilt — the UI disables the action
   * for them instead of failing after the click.
   */
  restorable: boolean;
}

const SELECT_AUDIT = `SELECT id, action, actor_type, actor_id, diff_data,
  is_checkpoint, review_status, reason, created_at, archived
  FROM ext_content_audit WHERE item_id = ? ORDER BY created_at ASC, rowid ASC`;

/** Every audit row for one item, oldest first. */
export async function listItemAuditRows(
  db: AuditDb,
  itemId: string,
): Promise<AuditRow[]> {
  const result = await db.prepare(SELECT_AUDIT).bind(itemId).all();
  // Rows arrive oldest first, so a single running flag is enough: once a
  // checkpoint has been seen, every later row can be replayed from it.
  let checkpointSeen = false;
  return result.results.map((row) => {
    let diffData: FieldChange[] = [];
    try {
      const parsed = JSON.parse(String(row.diff_data ?? "[]"));
      if (Array.isArray(parsed)) diffData = parsed as FieldChange[];
    } catch {
      // Keep an unreadable diff as empty rather than failing the detail page.
    }
    const isCheckpoint = Number(row.is_checkpoint ?? 0) === 1;
    if (isCheckpoint) checkpointSeen = true;
    return {
      action: String(row.action ?? ""),
      actorId: row.actor_id == null ? null : String(row.actor_id),
      actorType: String(row.actor_type ?? ""),
      // Archived rows stay in the replay chain and are only filtered out of the
      // listing — see migrations/0027.
      archived: Number(row.archived ?? 0) === 1,
      createdAt: String(row.created_at ?? ""),
      diffData,
      id: String(row.id ?? ""),
      isCheckpoint,
      reason: row.reason == null ? null : String(row.reason),
      restorable: checkpointSeen,
      reviewStatus: row.review_status == null ? null : String(row.review_status),
    };
  });
}

const SELECT_AUDIT_ROW = `SELECT id, diff_data, is_checkpoint, checkpoint_data, created_at
  FROM ext_content_audit WHERE item_id = ? ORDER BY created_at ASC, rowid ASC`;

/**
 * Reconstruct the item data as of one audit row: walk back to the nearest
 * checkpoint at or before that row, then replay the diffs forward (ADR-0003).
 * Returns null when the row does not belong to the item.
 */
export async function rebuildItemVersion(
  db: AuditDb,
  itemId: string,
  auditRowId: string,
): Promise<ItemData | null> {
  const result = await db.prepare(SELECT_AUDIT_ROW).bind(itemId).all();
  const rows = result.results;
  const targetIndex = rows.findIndex((row) => String(row.id ?? "") === auditRowId);
  if (targetIndex < 0) return null;

  let checkpointIndex = -1;
  for (let index = targetIndex; index >= 0; index -= 1) {
    if (Number(rows[index]!.is_checkpoint ?? 0) === 1) {
      checkpointIndex = index;
      break;
    }
  }
  if (checkpointIndex < 0) return null;

  let data: ItemData;
  try {
    data = JSON.parse(String(rows[checkpointIndex]!.checkpoint_data ?? "null"));
  } catch {
    return null;
  }
  if (data == null) return null;

  const diffs: FieldChange[] = [];
  for (let index = checkpointIndex + 1; index <= targetIndex; index += 1) {
    try {
      const parsed = JSON.parse(String(rows[index]!.diff_data ?? "[]"));
      if (Array.isArray(parsed)) diffs.push(...(parsed as FieldChange[]));
    } catch {
      return null;
    }
  }
  return rebuildFromCheckpoint(data, diffs);
}
