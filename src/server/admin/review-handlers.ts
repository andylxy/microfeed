import type {FeedContent} from "../../types";

import FeedDb from "@/server/feed/FeedDb";
import {createFeedCrud} from "@/server/feed/feed";
import {
  recordAudit,
  type AuditDb,
  type ItemData,
} from "@/server/feed/extContentAudit";
import {
  applyReviewTransition,
  isAllowedReviewTransition,
  listItemAuditRows,
  mergeRestoredVersion,
  readItemReviewStatus,
  rebuildItemVersion,
  reviewTransition,
  type ReviewAction,
} from "@/server/feed/extReview";
import {
  approveChapterVersions,
  listPendingChapters,
  rejectChapterVersions,
} from "@/server/feed/extContentReview";
import {STATUSES} from "@/shared/Constants";

/**
 * Dashboard-side operations for the novel-cms review queue.
 *
 * The state rules live in extReview (pure) and the persistence rules in
 * extContentAudit; this module only wires them to a request, the way the
 * category handlers do for genres.
 */

/** A review action may be recorded as itself rather than as a plain edit. */
export class ReviewActionError extends Error {
  /** HTTP status to answer with; 404 by default, 409 for an illegal transition. */
  status = 404;
  constructor(message: string, status = 404) {
    super(message);
    this.status = status;
  }
}

export interface ReviewQueuePayload {
  /**
   * Chapters with unconfirmed content versions. This used to be
   * `items.review_status = 'submitted'` — a label nothing ever set, showing the
   * live body — so the queue could not be entered and showed stale content.
   */
  items: Awaited<ReturnType<typeof listPendingChapters>>;
}

export async function listReviewQueueHandler(
  db: AuditDb,
): Promise<ReviewQueuePayload> {
  const items = await listPendingChapters(db as unknown as Parameters<
    typeof listPendingChapters
  >[0]);
  return {items};
}

/** Confirm every unconfirmed version of a chapter. */
export async function approveChapterHandler(
  db: AuditDb,
  itemId: string,
  reviewerId: string | null,
): Promise<{approved: number}> {
  const approved = await approveChapterVersions(
    db as unknown as Parameters<typeof approveChapterVersions>[0],
    itemId,
    reviewerId,
  );
  return {approved};
}

/** Reject them and put the chapter back to its pre-change content. */
export async function rejectChapterHandler(
  db: AuditDb,
  itemId: string,
  reviewerId: string | null,
): Promise<{restored: boolean; rejected: number}> {
  return rejectChapterVersions(
    db as unknown as Parameters<typeof rejectChapterVersions>[0],
    itemId,
    reviewerId,
  );
}

export async function listItemAuditHandler(
  db: AuditDb,
  itemId: string,
): Promise<{item: Record<string, unknown> | null; rows: Awaited<ReturnType<typeof listItemAuditRows>>}> {
  const [rows, item] = await Promise.all([
    listItemAuditRows(db, itemId),
    getItemData(db, itemId),
  ]);
  return {item, rows};
}

async function getItemData(
  db: AuditDb,
  itemId: string,
): Promise<Record<string, unknown> | null> {
  const row = await db
    .prepare("SELECT data FROM items WHERE id = ?")
    .bind(itemId)
    .first();
  if (row == null) return null;
  try {
    return JSON.parse(String((row as Record<string, unknown>).data ?? "null"));
  } catch {
    return null;
  }
}

/**
 * Move a chapter through the review state machine and record the action.
 *
 * Deliberately bypasses `updateItem`: that path records an `edit` audit row of
 * its own, and a reviewer approving a chapter should show up once, as
 * `approve`, not twice.
 */
export async function applyReviewActionHandler(
  request: Request,
  runtimeEnv: Env,
  itemId: string,
  action: ReviewAction,
  reason?: string | null,
): Promise<Record<string, unknown>> {
  const database = new FeedDb(runtimeEnv, request);
  const existing = await database.getItemById(itemId);
  if (!existing) throw new ReviewActionError("errors.review.itemMissing");

  const currentStatus = readItemReviewStatus(existing);
  if (!isAllowedReviewTransition(currentStatus, action)) {
    throw new ReviewActionError("errors.review.invalidTransition", 409);
  }

  const transition = reviewTransition(action, reason);
  const data = applyReviewTransition(
    existing as unknown as ItemData,
    transition,
  );
  const item = {
    ...(existing as unknown as Record<string, unknown>),
    ...data,
    id: itemId,
    status: transition.status,
  };

  const content = await database.getContent(null) as unknown as FeedContent;
  const feedCrud = createFeedCrud(content, database, request);
  await feedCrud.saveInternalItem(item);

  await recordAudit(database.FEED_DB as unknown as AuditDb, {
    action,
    actorType: "reviewer",
    channelId: null,
    diffData: [],
    isCheckpoint: false,
    itemId,
    reason: transition.reason,
    reviewStatus: transition.reviewStatus,
  });

  return {reviewStatus: transition.reviewStatus, status: transition.status};
}

/** Put a chapter back to an earlier audited version. */
export async function restoreItemVersionHandler(
  request: Request,
  runtimeEnv: Env,
  itemId: string,
  auditRowId: string,
): Promise<Record<string, unknown>> {
  const database = new FeedDb(runtimeEnv, request);
  const existing = await database.getItemById(itemId);
  if (!existing) throw new ReviewActionError("errors.review.itemMissing");

  const restored = await rebuildItemVersion(
    database.FEED_DB as unknown as AuditDb,
    itemId,
    auditRowId,
  );
  if (!restored) throw new ReviewActionError("errors.review.restoreUnavailable");

  const item = {
    ...mergeRestoredVersion(
      existing as unknown as ItemData,
      restored,
    ),
    id: itemId,
    // Restoring an old body must not silently republish a taken-down chapter.
    status: existing.status ?? STATUSES.UNPUBLISHED,
  };

  const content = await database.getContent(null) as unknown as FeedContent;
  const feedCrud = createFeedCrud(content, database, request);
  await feedCrud.saveInternalItem(item);

  await recordAudit(database.FEED_DB as unknown as AuditDb, {
    action: "restore",
    actorType: "reviewer",
    channelId: null,
    diffData: [],
    isCheckpoint: false,
    itemId,
    reviewStatus: readItemReviewStatus(item),
  });

  return {restored: true};
}
