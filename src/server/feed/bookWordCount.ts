import {STATUSES} from "@/shared/Constants";
import {bodyToPlainText} from "@/shared/BodyFormat";

/**
 * One word count for the whole site.
 *
 * Books used to carry a hand-typed `_microfeed.wordCount` while the book page
 * summed the per-chapter numbers — two sources that drifted apart badly enough
 * to be comic: the sample books declared 520,000–1,240,000 characters against
 * three chapters of roughly 50. Declared values are never recomputed, so any
 * edit leaves them lying; the only number that cannot drift is the one counted
 * from the body text that is actually on the site.
 *
 * So: every surface (reader, shelf, category, book detail, dashboard) reads
 * this one derivation, and `data._microfeed.wordCount` becomes a stored
 * artifact of the past rather than something anyone displays.
 */

export interface WordCountDbPreparedStatement {
  bind(...values: unknown[]): WordCountDbPreparedStatement;
  all(): Promise<{results: Record<string, unknown>[]}>;
}

/** Structural subset of `BookDb` / `CategoryDb`; both are assignable to it. */
export interface WordCountDb {
  prepare(query: string): WordCountDbPreparedStatement;
}

/**
 * Characters in a body, HTML stripped and whitespace dropped.
 *
 * Chinese prose has no word boundaries worth counting, so this counts
 * characters the way novel sites do: what is left after the markup and the
 * indentation are gone.
 */
export function countBodyText(
  value: unknown,
  format: unknown = undefined,
): number {
  if (typeof value !== "string" || !value) return 0;
  // Markdown syntax is not prose: `#` and `**` must not count as characters, so
  // the body is rendered before it is measured.
  return bodyToPlainText(value, format).replace(/\s+/gu, "").length;
}

/**
 * A chapter's word count, from whichever field actually holds the body.
 *
 * `description` is canonical (novel-cms stores the HTML there); the other two
 * are fallbacks for items written by other importers. Not a sum: `content_text`
 * is derived FROM `description`, so adding them would double-count.
 */
export function chapterWordCount(data: Record<string, unknown>): number {
  for (const field of ["description", "content_html", "content_text"]) {
    const count = countBodyText(data[field], data["content_format"]);
    if (count > 0) return count;
  }
  return 0;
}

function parseData(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function pocketOf(data: Record<string, unknown>): Record<string, unknown> {
  const pocket = data["_microfeed"];
  return pocket && typeof pocket === "object"
    ? pocket as Record<string, unknown>
    : {};
}

/**
 * Word count per book, summed over its published chapters.
 *
 * Membership is resolved in JavaScript because D1 rejects the nested
 * `json_extract(data, '$._microfeed.bookId')` path form (see `getBookChapters`).
 */
export async function bookWordCounts(db: WordCountDb): Promise<Map<string, number>> {
  const result = await db.prepare(
    "SELECT data FROM items WHERE status = ?",
  ).bind(STATUSES.PUBLISHED).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  const totals = new Map<string, number>();
  for (const row of rows) {
    const data = parseData(row["data"]);
    const bookId = pocketOf(data)["bookId"];
    if (typeof bookId !== "string" || !bookId.trim()) continue;
    const key = bookId.trim();
    totals.set(key, (totals.get(key) ?? 0) + chapterWordCount(data));
  }
  return totals;
}
