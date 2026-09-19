import {randomShortUUID} from "@/shared/StringUtils";
import {
  computeDiff,
  countCheckpoints,
  countAuditRecords,
  readReviewStatus,
  recordAudit,
  shouldCheckpoint,
  AUDIT_CHECKPOINT_INTERVAL,
  type ActorType,
  type AuditAction,
  type AuditDb,
  type FieldChange,
  type ItemData,
} from "@/server/feed/extContentAudit";

/** Re-exported so callers (and tests) can name the port without reaching into
 *  the audit module. */
export type {AuditDb, AuditDbPreparedStatement} from "@/server/feed/extContentAudit";

/**
 * The content-review chain.
 *
 * Everything that changes a chapter goes through {@link recordContentChange}:
 * it writes the audit row (field-level diff + periodic checkpoints, ADR-0003)
 * **and** opens a pending version holding the pre-change snapshot. The queue is
 * then "chapters with unconfirmed versions", and rejecting one actually puts the
 * chapter back instead of just relabelling it.
 *
 * This exists because the previous model was a label with no chain behind it:
 * nothing ever set `reviewStatus = 'submitted'`, there was no submit action, and
 * the queue read the live body — so content could change after entering review
 * and a rejection could not undo anything.
 */

export type ReviewStatus = "pending" | "approved" | "rejected";

export interface ContentReview {
  id: string;
  itemId: string;
  status: ReviewStatus;
  action: string;
  changes: FieldChange[];
  submittedBy: string | null;
  submittedAt: number | null;
  reviewedBy: string | null;
  reviewedAt: number | null;
  reason: string | null;
}

export interface PendingChapter {
  itemId: string;
  title: string;
  pendingCount: number;
  lastSubmittedBy: string | null;
  lastSubmittedAt: number | null;
  /** Field-level changes of the newest unconfirmed version. */
  changes: FieldChange[];
  /** Set when the chapter still exists; null if it was deleted meanwhile. */
  exists: boolean;
}

const INSERT_REVIEW = `INSERT INTO ext_content_review (
  id, item_id, status, diff_data, snapshot_data, action,
  submitted_by, submitted_at, reason
) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)`;

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toReview(row: Record<string, unknown>): ContentReview {
  return {
    action: String(row.action ?? "edit"),
    changes: parseJson<FieldChange[]>(row.diff_data, []),
    id: String(row.id ?? ""),
    itemId: String(row.item_id ?? ""),
    reason: row.reason == null ? null : String(row.reason),
    reviewedAt: row.reviewed_at == null ? null : Number(row.reviewed_at),
    reviewedBy: row.reviewed_by == null ? null : String(row.reviewed_by),
    status: String(row.status ?? "pending") as ReviewStatus,
    submittedAt: row.submitted_at == null ? null : Number(row.submitted_at),
    submittedBy: row.submitted_by == null ? null : String(row.submitted_by),
  };
}

/** The single entry point every content change must use. */
export interface ContentChangeParams {
  action: AuditAction;
  actorId?: string | null;
  actorType?: ActorType;
  /** The chapter before the change — the rollback target if it is rejected. */
  before: Record<string, unknown>;
  /** The chapter after the change. */
  after: Record<string, unknown>;
  itemId: string;
  reason?: string | null;
  reviewStatus?: string | null;
  /**
   * Whether this change opens a pending version. Default true.
   *
   * Review actions themselves (restoring a version, applying an approved
   * correction) are already decisions — opening another pending version for
   * them would mean a decision needs re-deciding, forever.
   */
  openReview?: boolean;
}

/**
 * Record one content change: audit row + a pending version to confirm.
 *
 * A change that alters nothing records nothing — there is no version to review.
 */
export async function recordContentChange(
  db: AuditDb,
  params: ContentChangeParams,
): Promise<ContentReview | null> {
  const {itemId, before, after} = params;
  if (!itemId) return null;
  const changes = computeDiff(
    before as ItemData,
    after as ItemData,
  );
  if (changes.length === 0) return null;

  // Keep the audit chain restorable: a snapshot whenever the item has none yet
  // (first row, or the first edit after a legacy chain).
  const existingCount = await countAuditRecords(db, itemId);
  const hasCheckpoint = await countCheckpoints(db, itemId);
  const isCheckpoint = hasCheckpoint === 0
    ? true
    : shouldCheckpoint(existingCount, AUDIT_CHECKPOINT_INTERVAL);

  await recordAudit(db, {
    action: params.action,
    actorId: params.actorId ?? null,
    actorType: params.actorType ?? "author",
    channelId: null,
    checkpointData: isCheckpoint ? (after as ItemData) : null,
    diffData: changes,
    isCheckpoint,
    itemId,
    reason: params.reason ?? null,
    reviewStatus: params.reviewStatus ?? readReviewStatus(after),
  });

  if (params.openReview === false) return null;

  const id = randomShortUUID();
  const now = Date.now();
  await db.prepare(INSERT_REVIEW).bind(
    id,
    itemId,
    JSON.stringify(changes),
    JSON.stringify(before),
    params.action,
    params.actorId ?? null,
    now,
    params.reason ?? null,
  ).run();

  return {
    action: params.action,
    changes,
    id,
    itemId,
    reason: params.reason ?? null,
    reviewedAt: null,
    reviewedBy: null,
    status: "pending",
    submittedAt: now,
    submittedBy: params.actorId ?? null,
  };
}

/** Every pending version of one chapter, oldest first. */
export async function listChapterReviews(
  db: AuditDb,
  itemId: string,
): Promise<ContentReview[]> {
  const result = await db.prepare(
    "SELECT * FROM ext_content_review WHERE item_id = ? " +
      "ORDER BY submitted_at ASC, rowid ASC",
  ).bind(itemId).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  return rows.map(toReview);
}

function titleOf(data: Record<string, unknown>): string {
  return typeof data.title === "string" ? data.title : "";
}

/**
 * The review queue: chapters with unconfirmed versions, oldest first. Each row
 * carries the newest unconfirmed change so the queue can show what is waiting.
 */
export async function listPendingChapters(db: AuditDb): Promise<PendingChapter[]> {
  const result = await db.prepare(
    "SELECT * FROM ext_content_review WHERE status = 'pending' " +
      "ORDER BY submitted_at ASC, rowid ASC",
  ).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  const byItem = new Map<string, ContentReview[]>();
  for (const row of rows) {
    const review = toReview(row);
    const list = byItem.get(review.itemId);
    if (list) list.push(review);
    else byItem.set(review.itemId, [review]);
  }

  const chapters: PendingChapter[] = [];
  for (const [itemId, reviews] of byItem) {
    const row = await db.prepare(
      "SELECT data FROM items WHERE id = ?",
    ).bind(itemId).first() as Record<string, unknown> | null;
    const data = row ? parseJson<Record<string, unknown>>(row.data, {}) : null;
    const last = reviews[reviews.length - 1]!;
    chapters.push({
      changes: last.changes,
      exists: data != null,
      itemId,
      lastSubmittedAt: last.submittedAt,
      lastSubmittedBy: last.submittedBy,
      pendingCount: reviews.length,
      title: data ? titleOf(data) : "",
    });
  }
  return chapters;
}

/**
 * Confirm a chapter's unconfirmed versions. The content is already live — this
 * records that someone reviewed and accepted it.
 */
export async function approveChapterVersions(
  db: AuditDb,
  itemId: string,
  reviewerId: string | null,
): Promise<number> {
  // Count first, then update: not every driver reports `changes`, and the number
  // of confirmed versions is what the caller actually wants to know.
  const open = (await listChapterReviews(db, itemId))
    .filter((review) => review.status === "pending");
  if (open.length === 0) return 0;

  const now = Date.now();
  await db.prepare(
    "UPDATE ext_content_review SET status = 'approved', " +
      "reviewed_by = ?, reviewed_at = ? WHERE item_id = ? AND status = 'pending'",
  ).bind(reviewerId, now, itemId).run();
  return open.length;
}

/**
 * Reject a chapter's unconfirmed versions and put the chapter back to how it was
 * before the earliest unconfirmed change. Later pending versions are rejected
 * with it: their content is being undone too.
 */
export async function rejectChapterVersions(
  db: AuditDb,
  itemId: string,
  reviewerId: string | null,
): Promise<{restored: boolean; rejected: number}> {
  const pending = await listChapterReviews(db, itemId);
  const open = pending.filter((review) => review.status === "pending");
  if (open.length === 0) return {rejected: 0, restored: false};

  const now = Date.now();
  await db.prepare(
    "UPDATE ext_content_review SET status = 'rejected', " +
      "reviewed_by = ?, reviewed_at = ? WHERE item_id = ? AND status = 'pending'",
  ).bind(reviewerId, now, itemId).run();

  // Restore the snapshot captured before the earliest unconfirmed change.
  const earliest = open[0]!;
  const snapshot = await db.prepare(
    "SELECT snapshot_data FROM ext_content_review WHERE id = ?",
  ).bind(earliest.id).first() as Record<string, unknown> | null;
  const data = snapshot ? parseJson<Record<string, unknown> | null>(
    snapshot.snapshot_data,
    null,
  ) : null;
  if (!data) return {rejected: open.length, restored: false};

  await db.prepare(
    "UPDATE items SET data = ?, updated_at = ? WHERE id = ?",
  ).bind(
    JSON.stringify(data),
    new Date(now).toISOString().replace("T", " ").slice(0, 19),
    itemId,
  ).run();

  await recordAudit(db, {
    action: "restore",
    actorId: reviewerId,
    actorType: "reviewer",
    channelId: null,
    checkpointData: null,
    diffData: [],
    isCheckpoint: false,
    itemId,
    reason: null,
    reviewStatus: readReviewStatus(data),
  });

  return {rejected: open.length, restored: true};
}
