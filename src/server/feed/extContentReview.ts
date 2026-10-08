import {bodyToPlainText} from "@/shared/BodyFormat";
import {SETTINGS_CATEGORIES} from "@/shared/Constants";
import {randomShortUUID} from "@/shared/StringUtils";
import {msToRFC3339} from "@/shared/TimeUtils";
import {
  auditInsertStatement,
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
  type AuditDbPreparedStatement,
  type FieldChange,
  type ItemData,
} from "@/server/feed/extContentAudit";

/** Re-exported so callers (and tests) can name the port without reaching into
 *  the audit module. */
export type {AuditDb, AuditDbPreparedStatement} from "@/server/feed/extContentAudit";

/**
 * The content-review chain.
 *
 * 内容变更的统一规划原语是 {@link planContentChange}：它读齐判定所需状态，产出
 * 「审计行（字段级 diff + 周期检查点，ADR-0003）+ 开启 review 时的待审版本行 +
 * 回拨语句」，**但不提交**——调用方把这些语句与 item 写入并成同一批
 * `db.batch()`，让 item 与审计原子地同批生效（W5 修复的 item↔audit 不一致窗口）。
 *
 * 队列即「带未确认版本的章节」；拒绝一个版本会把章节回拨到上次已批准内容，
 * 标签之外的正文也一并回拨。
 *
 * 这条链存在的原因：旧模型只有标签、背后没有链——没有任何地方把
 * `reviewStatus` 置为 `submitted`，没有提交动作，队列还直接读线上正文，于是内容
 * 进了 review 还能改、拒绝也无法撤销。
 *
 * {@link recordContentChange} 是 {@link planContentChange} 的自提交薄封装：拿到
 * 计划后立即逐条 `run()`。它留给「不并入更大批次」的调用方用；当前所有单条
 * 内容变更路径（items/service.ts、ajax/feed.ts）都已改走 planContentChange + 批
 * 提交，故该封装暂无在仓内调用方，仅作为非批式回退保留。
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
}

const INSERT_REVIEW = `INSERT INTO ext_content_review (
  id, item_id, status, diff_data, snapshot_data, proposed_data, action,
  submitted_by, submitted_at, reason
) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`;

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

/**
 * Put the chapter's public content back to the last approved state: the snapshot
 * captured by the earliest still-pending version. No-op when nothing is pending
 * (everything confirmed), and when the item is already at that content.
 */
/** `items.data` 存的是 item 去掉那 6 个合成键之后的 JSON，见
 *  `FeedDb._putItemToContentStatement` 的解构。用于和快照做「内容是否已一致」的比较。 */
function storedItemDataJson(item: Record<string, unknown>): string {
  const {
    contentText: _contentText,
    createdAtMs: _createdAtMs,
    id: _id,
    pubDateMs: _pubDateMs,
    status: _status,
    updatedAtMs: _updatedAtMs,
    ...data
  } = item;
  return JSON.stringify(data);
}

/**
 * 规划「把公开内容按回最后一次已批准状态」的语句，返回 null 表示无需回拨。
 *
 * 全部状态都在批前读里定下来：本行的版本行此刻还没插入，所以「最早 pending」要么是
 * 更早那次留下的，要么就是本次快照（`currentSnapshotJson`）——两种情况都能在这里
 * 判定，于是这条 UPDATE 可以和 item 写、审计写一起进同一个批次。
 */
async function planPinToLastApproved(
  db: AuditDb,
  itemId: string,
  currentSnapshotJson: string,
  after: Record<string, unknown>,
): Promise<AuditDbPreparedStatement | null> {
  const pending = await db.prepare(
    "SELECT snapshot_data FROM ext_content_review WHERE item_id = ? " +
      "AND status = 'pending' ORDER BY submitted_at ASC, rowid ASC LIMIT 1",
  ).bind(itemId).first() as Record<string, unknown> | null;
  const approvedRaw = pending
    ? String(pending.snapshot_data ?? "")
    : currentSnapshotJson;
  if (!approvedRaw || storedItemDataJson(after) === approvedRaw) return null;

  // `items.data` carries its own `status` field alongside the `status` column.
  // Restoring the snapshot would rewind that copy and make a published chapter
  // look unpublished again (draft-only enforcement and the public feed both read
  // it), so the gate only holds back CONTENT — status stays as it is now.
  let approved = approvedRaw;
  const currentStatus = after["status"];
  if (currentStatus != null) {
    try {
      const parsed = JSON.parse(approvedRaw) as Record<string, unknown>;
      parsed.status = currentStatus;
      approved = JSON.stringify(parsed);
    } catch {
      // Unparseable snapshot: leave it exactly as stored rather than guessing.
    }
  }

  return writeItemContentStatement(db, itemId, approved);
}

/**
 * 把章节按回最后一次已批准状态（自带提交）。
 *
 * 与 `planContentChange` 里的回拨共用同一套判定，只是这里没有「本次快照」——
 * 拒审之后若已无 pending，就什么都不做。
 */
async function pinToLastApproved(db: AuditDb, itemId: string): Promise<boolean> {
  const row = await db.prepare(
    "SELECT data, status FROM items WHERE id = ?",
  ).bind(itemId).first() as Record<string, unknown> | null;
  if (!row) return false;
  const data = parseJson<Record<string, unknown>>(row["data"], {});
  const pin = await planPinToLastApproved(db, itemId, "", {
    ...data,
    status: row["status"],
  });
  if (!pin) return false;
  await pin.run();
  return true;
}

interface DerivedColumns {
  contentText: string;
  pubDate: string | null;
  reviewStatus: string | null;
}

/**
 * Write `items.data` **and** the columns derived from it.
 *
 * `items.data` is not the whole row: `content_text` (search), `review_status`
 * (queue index) and `pub_date` are mirrors the normal save path refreshes
 * alongside it. Writing only `data` leaves them pointing at different content —
 * holding a change back still answered searches with the pending body, and
 * confirming one never refreshed the search text at all.
 */
export function writeItemContentStatement(
  db: AuditDb,
  itemId: string,
  dataJson: string,
): AuditDbPreparedStatement {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const derived = parseDerivedColumns(dataJson);

  if (!derived) {
    // Unparseable content: still write it, but leave the mirrors untouched
    // rather than blanking search text on a guess.
    return db.prepare("UPDATE items SET data = ?, updated_at = ? WHERE id = ?")
      .bind(dataJson, timestamp, itemId);
  }

  return db.prepare(
    "UPDATE items SET data = ?, content_text = ?, content_text_updated_at = ?, " +
      "review_status = ?, pub_date = COALESCE(?, pub_date), updated_at = ? " +
      "WHERE id = ?",
  ).bind(
    dataJson,
    derived.contentText,
    timestamp,
    derived.reviewStatus,
    derived.pubDate,
    timestamp,
    itemId,
  );
}

/** 写回正文（自带提交）。要并进更大的批次时用 `writeItemContentStatement`。 */
export async function writeItemContent(
  db: AuditDb,
  itemId: string,
  dataJson: string,
): Promise<void> {
  await writeItemContentStatement(db, itemId, dataJson).run();
}

/** Re-derive the columns that mirror `items.data`. Null when it will not parse. */
function parseDerivedColumns(dataJson: string): DerivedColumns | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(dataJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  return deriveColumns(data);
}

function deriveColumns(data: Record<string, unknown>): DerivedColumns {
  const microfeed = data["_microfeed"] as Record<string, unknown> | undefined;
  const reviewStatus = typeof microfeed?.["reviewStatus"] === "string"
    ? microfeed["reviewStatus"]
    : null;
  const publishedMs = data["date_published_ms"];
  const pubDate = typeof publishedMs === "number" && Number.isFinite(publishedMs)
    ? msToRFC3339(publishedMs)
    : null;
  return {
    contentText: bodyToPlainText(data["description"], data["content_format"]),
    pubDate,
    reviewStatus,
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
   * Force the review decision instead of reading the `contentReview` setting.
   *
   * Omit it for normal content changes — the setting decides, and with review
   * off (the default) the change is recorded in the audit trail and nothing else.
   * Pass `false` for review actions themselves (restoring a version, applying an
   * approved correction): they are already decisions, so opening another pending
   * version for them would mean a decision needs re-deciding, forever.
   */
  openReview?: boolean;
}

/**
 * Is the content-review gate on for this instance?
 *
 * Stored as a JSON blob under `settings.category = 'contentReview'`; an absent
 * row — the default — means OFF.
 *
 * This is read at the single content-change seam rather than by each caller.
 * The earlier design pushed the decision onto callers, and only the dashboard
 * editor remembered it: the content write API (`createItem` / `updateItem` /
 * `deleteItem`) and the volume board queued every change even with the switch
 * off, so the review queue kept filling up on an instance that had review
 * disabled.
 */
async function contentReviewEnabled(db: AuditDb): Promise<boolean> {
  try {
    const row = await db.prepare(
      "SELECT data FROM settings WHERE category = ? LIMIT 1",
    ).bind(SETTINGS_CATEGORIES.CONTENT_REVIEW).first() as
      | Record<string, unknown>
      | null;
    if (!row) return false;
    const parsed = JSON.parse(String(row["data"] ?? "")) as {
      enabled?: unknown;
    };
    return parsed.enabled === true;
  } catch {
    // An unreadable settings row must not gate content: fail open (record the
    // change, open no version) rather than queue every edit on a parse accident.
    return false;
  }
}

/** 一次内容变更要提交的语句，外加它开启的待审版本（未开启 review 时为 null）。 */
export interface ContentChangePlan {
  statements: AuditDbPreparedStatement[];
  review: ContentReview | null;
}

/**
 * 规划一次内容变更：读齐判定所需的状态，产出「审计行 +（review 开启时）版本行 +
 * 回拨语句」。调用方决定何时提交——并进更大的批次，就与 item 写入同批生效。
 */
export async function planContentChange(
  db: AuditDb,
  params: ContentChangeParams,
): Promise<ContentChangePlan> {
  const {itemId, before, after} = params;
  if (!itemId) return {statements: [], review: null};
  const changes = computeDiff(
    before as ItemData,
    after as ItemData,
  );
  if (changes.length === 0) return {statements: [], review: null};

  // Keep the audit chain restorable: a snapshot whenever the item has none yet
  // (first row, or the first edit after a legacy chain).
  const existingCount = await countAuditRecords(db, itemId);
  const hasCheckpoint = await countCheckpoints(db, itemId);
  const isCheckpoint = hasCheckpoint === 0
    ? true
    : shouldCheckpoint(existingCount, AUDIT_CHECKPOINT_INTERVAL);

  const statements: AuditDbPreparedStatement[] = [auditInsertStatement(db, {
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
  })];

  if (params.openReview === false) return {statements, review: null};
  // No explicit decision -> the instance setting decides. Review is OFF by
  // default: the audit row planned above is the whole record, and the change
  // takes effect immediately (no pending version, no pin-to-approved gate).
  if (params.openReview !== true && !await contentReviewEnabled(db)) {
    return {statements, review: null};
  }

  const id = randomShortUUID();
  const now = Date.now();
  // A creation has no prior content, so `before` is empty. Using it as the
  // snapshot would make the gate pin the item to that empty object and wipe the
  // chapter that was just created — so for the first version the snapshot IS the
  // created content (the gate becomes a no-op) while the change still opens for
  // review, with every field showing as added.
  const snapshot = Object.keys(before).length === 0 ? after : before;

  statements.push(db.prepare(INSERT_REVIEW).bind(
    id,
    itemId,
    JSON.stringify(changes),
    JSON.stringify(snapshot),
    JSON.stringify(after),
    params.action,
    params.actorId ?? null,
    now,
    params.reason ?? null,
  ));

  // Gate: the caller is about to write `after` to items.data, which would put
  // unconfirmed content on the public site. Pin the item back to the last
  // approved content — that is the snapshot of the EARLIEST pending version, so
  // several queued changes do not leak either.
  //
  // Only content is held back. A change that moves `status` (publish, unpublish,
  // delete, create) is an explicit decision, not body text: gating it would
  // rewind the status copy inside `data` and make published chapters look like
  // drafts again (draft-only enforcement and the public feed both read it).
  const touchesStatus = changes.some((change) => change.path === "status");
  if (!touchesStatus) {
    const pin = await planPinToLastApproved(
      db,
      itemId,
      JSON.stringify(snapshot),
      after,
    );
    if (pin) statements.push(pin);
  }

  return {
    statements,
    review: {
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
    },
  };
}

/**
 * 记录一次内容变更（自带提交）。
 *
 * 未改动内容的版本不产生审计记录——没有可供评审的版本。
 * 要把它并进更大的批次（与 item 写入同批生效）时用 `planContentChange`。
 */
export async function recordContentChange(
  db: AuditDb,
  params: ContentChangeParams,
): Promise<ContentReview | null> {
  const plan = await planContentChange(db, params);
  for (const statement of plan.statements) await statement.run();
  return plan.review;
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
 *
 * Joined to `items` deliberately: a pending version whose chapter no longer
 * exists can never be confirmed or rejected, so it is not a queue entry — it is
 * residue from a delete that bypassed this chain. Listing it would ask a
 * reviewer to act on something that is not there.
 */
export async function listPendingChapters(db: AuditDb): Promise<PendingChapter[]> {
  const result = await db.prepare(
    "SELECT r.* FROM ext_content_review r JOIN items i ON i.id = r.item_id " +
      "WHERE r.status = 'pending' ORDER BY r.submitted_at ASC, r.rowid ASC",
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
    if (!row) continue;
    const data = parseJson<Record<string, unknown>>(row.data, {});
    const last = reviews[reviews.length - 1]!;
    chapters.push({
      changes: last.changes,
      itemId,
      lastSubmittedAt: last.submittedAt,
      lastSubmittedBy: last.submittedBy,
      pendingCount: reviews.length,
      title: titleOf(data),
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

  // Promote the newest proposed content: this is the moment the change becomes
  // public. Until now items.data was pinned to the previously approved content.
  const newest = await db.prepare(
    "SELECT proposed_data FROM ext_content_review WHERE item_id = ? " +
      "AND status = 'pending' ORDER BY submitted_at DESC, rowid DESC LIMIT 1",
  ).bind(itemId).first() as Record<string, unknown> | null;
  const proposed = newest ? String(newest.proposed_data ?? "") : "";
  if (proposed) {
    // Same mirrors as the gate rolls back: confirming a change is the moment the
    // searchable text has to catch up with the body.
    await writeItemContent(db, itemId, proposed);
  }

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

  // The public content was never advanced (the gate pinned it), so dropping the
  // pending versions is all it takes; if earlier changes are still open, the pin
  // moves back to the last approved state.
  await pinToLastApproved(db, itemId);

  await recordAudit(db, {
    action: "reject",
    actorId: reviewerId,
    actorType: "reviewer",
    channelId: null,
    checkpointData: null,
    diffData: [],
    isCheckpoint: false,
    itemId,
    reason: null,
    reviewStatus: null,
  });

  return {rejected: open.length, restored: true};
}
