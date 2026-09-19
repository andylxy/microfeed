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
  listPendingReviewItems,
  mergeRestoredVersion,
  readItemReviewStatus,
  rebuildItemVersion,
  reviewTransition,
  type ReviewAction,
} from "@/server/feed/extReview";
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
  items: Awaited<ReturnType<typeof listPendingReviewItems>>;
}

export async function listReviewQueueHandler(
  db: AuditDb,
): Promise<ReviewQueuePayload> {
  const items = await listPendingReviewItems(db);
  return {items};
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
