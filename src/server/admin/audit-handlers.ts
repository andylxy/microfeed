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

/**
 * `created_at` was written in two shapes over time: epoch milliseconds by the
 * audit module, and `YYYY-MM-DD HH:MM:SS` by the correction module. Ordering on
 * the raw column mixes them up, so normalise both to milliseconds first.
 */
const CREATED_AT_MS =
  "COALESCE(strftime('%s', created_at) * 1000, CAST(created_at AS INTEGER))";

/** Chapters that have an audit trail, most recently changed first. */
export async function listAuditChaptersHandler(
  db: AuditDb,
  limit = 200,
): Promise<{chapters: AuditChapterRow[]}> {
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
  const [rows, item] = await Promise.all([
    listItemAuditRows(db, itemId),
    getItemData(db, itemId),
  ]);
  return {
    item,
    rows: rows.map((row) => ({...row, createdAt: toIso(row.createdAt)})),
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
