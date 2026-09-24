import type {AuditDb} from "@/server/feed/extContentAudit";
import {listItemAuditRows} from "@/server/feed/extReview";

/**
 * Audit browsing, kept separate from `/admin/review/`: the review page decides
 * what to do with unconfirmed changes; this page only *shows* what happened.
 */

export interface AuditChapterRow {
  id: string;
  title: string;
  changeCount: number;
  lastChangedAt: number | null;
}

/** One review version of one chapter, as the audit page displays it (read-only). */
export interface ReviewRecordRow {
  id: string;
  action: string;
  /** `pending` | `approved` | `rejected`. */
  status: string;
  submittedAt: number | null;
  reviewedAt: number | null;
  /** From the proposed content; falls back to the snapshot when absent. */
  title: string;
  chapterNo: string | number | null;
  volume: string | null;
  /** The body the version proposed — rendered read-only on the page. */
  contentHtml: string;
}

/**
 * Every review version of one chapter, newest first, flattened into display
 * objects. Purely for showing: approving and rejecting live on `/admin/review/`,
 * and nothing here offers either.
 */
export async function listReviewRecordsHandler(
  db: AuditDb,
  itemId: string,
): Promise<{records: ReviewRecordRow[]}> {
  assertD1Handle(db);
  const result = await db.prepare(
    "SELECT id, action, status, submitted_at, reviewed_at, proposed_data, snapshot_data " +
      "FROM ext_content_review WHERE item_id = ? " +
      "ORDER BY submitted_at DESC, rowid DESC",
  ).bind(itemId).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  const records = rows.map((row) => {
    const record = row as Record<string, unknown>;
    // The proposed content is what the version wanted the chapter to become;
    // a creation's proposal doubles as its snapshot, so either source shows
    // the same thing. Parse leniently: a malformed JSON row must not take the
    // whole page down.
    const source = (String(record["proposed_data"] ?? "").trim() ||
      String(record["snapshot_data"] ?? "").trim());
    let data: Record<string, unknown> = {};
    if (source) {
      try {
        data = JSON.parse(source) as Record<string, unknown>;
      } catch {
        data = {};
      }
    }
    const microfeed = (data["_microfeed"] ?? {}) as Record<string, unknown>;
    const rawChapterNo = microfeed["chapterNo"];
    const submittedAt = Number(record["submitted_at"] ?? 0);
    const reviewedAt = Number(record["reviewed_at"] ?? 0);
    return {
      action: String(record["action"] ?? "edit"),
      chapterNo: typeof rawChapterNo === "string" || typeof rawChapterNo === "number"
        ? rawChapterNo
        : null,
      contentHtml: typeof data["description"] === "string"
        ? data["description"]
        : "",
      id: String(record["id"] ?? ""),
      reviewedAt: Number.isFinite(reviewedAt) && reviewedAt > 0 ? reviewedAt : null,
      status: String(record["status"] ?? "pending"),
      submittedAt:
        Number.isFinite(submittedAt) && submittedAt > 0 ? submittedAt : null,
      title: typeof data["title"] === "string" ? data["title"] : "",
      volume: typeof microfeed["volume"] === "string" ? microfeed["volume"] : null,
    };
  });
  return {records: records.filter((record) => record.id !== "")};
}

/**
 * Hide a row from the dashboard (or bring it back), without touching the row
 * itself.
 *
 * Deliberately not a DELETE: `rebuildItemVersion` replays diffs forward from the
 * nearest checkpoint, so dropping one row would corrupt every version after it.
 * The flag is the only field ever written back to `ext_content_audit` — the
 * diff, the snapshot and the timestamp are immutable once recorded.
 */
export async function setAuditRowArchivedHandler(
  db: AuditDb,
  itemId: string,
  auditRowId: string,
  archived: boolean,
): Promise<{archived: boolean; found: boolean}> {
  assertD1Handle(db);
  // Scoped to the item so a mismatched id can never reach another chapter.
  const row = await db.prepare(
    "SELECT id FROM ext_content_audit WHERE id = ? AND item_id = ?",
  ).bind(auditRowId, itemId).first();
  if (!row) return {archived, found: false};

  await db.prepare(
    "UPDATE ext_content_audit SET archived = ? WHERE id = ? AND item_id = ?",
  ).bind(archived ? 1 : 0, auditRowId, itemId).run();
  return {archived, found: true};
}

/**
 * `created_at` was written in two shapes over time: epoch milliseconds by the
 * audit module, and `YYYY-MM-DD HH:MM:SS` by the correction module. Ordering on
 * the raw column mixes them up, so normalise both to milliseconds first.
 */
const CREATED_AT_MS =
  "COALESCE(strftime('%s', created_at) * 1000, CAST(created_at AS INTEGER))";

/**
 * `FeedDb` declares `[member: string]: any`, so it is structurally assignable
 * to `AuditDb` — passing the wrapper instead of `env.FEED_DB` type-checks and
 * then dies at runtime with "prepare is not a function" (a bare 500 in the
 * dashboard). Fail loudly instead.
 */
function assertD1Handle(db: AuditDb): void {
  if (typeof db?.prepare !== "function") {
    throw new Error(
      "audit handlers need a D1 handle (env.FEED_DB), not a FeedDb wrapper",
    );
  }
}

/** Chapters that have an audit trail, most recently changed first. */
export async function listAuditChaptersHandler(
  db: AuditDb,
  limit = 200,
): Promise<{chapters: AuditChapterRow[]}> {
  assertD1Handle(db);
  const result = await db.prepare(`
    SELECT
      a.item_id AS id,
      COUNT(*) AS change_count,
      MAX(${CREATED_AT_MS}) AS last_changed_at,
      json_extract(i.data, '$.title') AS title
    FROM ext_content_audit a
    LEFT JOIN items i ON i.id = a.item_id
    GROUP BY a.item_id
    ORDER BY last_changed_at DESC
    LIMIT ?
  `).bind(limit).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  const chapters = rows.map((row) => {
    const record = row as Record<string, unknown>;
    const lastChangedAt = Number(record["last_changed_at"] ?? 0);
    return {
      changeCount: Number(record["change_count"] ?? 0),
      id: String(record["id"] ?? ""),
      lastChangedAt:
        Number.isFinite(lastChangedAt) && lastChangedAt > 0 ? lastChangedAt : null,
      title: String(record["title"] ?? "").trim(),
    };
  });
  return {chapters: chapters.filter((chapter) => chapter.id !== "")};
}

/**
 * `created_at` holds either epoch milliseconds or `YYYY-MM-DD HH:MM:SS`, so
 * hand the client one shape (ISO) it can format in local time.
 */
function toIso(value: string): string {
  const raw = value.trim();
  if (/^\d+$/.test(raw)) {
    const ms = Number(raw);
    if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
  }
  return raw.replace(" ", "T");
}

/** One chapter's audit trail — the history of that chapter, oldest first. */
export async function listAuditTrailHandler(
  db: AuditDb,
  itemId: string,
): Promise<{
  item: Record<string, unknown> | null;
  rows: Awaited<ReturnType<typeof listItemAuditRows>>;
}> {
  assertD1Handle(db);
  const [rows, item] = await Promise.all([
    listItemAuditRows(db, itemId),
    getItemData(db, itemId),
  ]);
  return {
    item,
    // `listItemAuditRows` walks oldest → newest (it needs that order to decide
    // which rows a checkpoint can rebuild). `git log` reads newest first, and
    // the newest change is the one you came to look at, so flip it for display.
    rows: rows
      .map((row) => ({...row, createdAt: toIso(row.createdAt)}))
      .reverse(),
  };
}

async function getItemData(
  db: AuditDb,
  itemId: string,
): Promise<Record<string, unknown> | null> {
  const row = await db
    .prepare("SELECT data FROM items WHERE id = ?")
    .bind(itemId)
    .first();
  if (!row) return null;
  try {
    const data = JSON.parse(String((row as Record<string, unknown>)["data"] ?? "{}")) as unknown as Record<string, unknown>;
    return data;
  } catch {
    return null;
  }
}
