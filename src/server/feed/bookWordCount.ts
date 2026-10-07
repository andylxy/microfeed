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

/**
 * Word count per book, summed over its published chapters.
 *
 * 按 D1 官方建议只投影所需列（bookId 表达式 + content_text），并分页流式读取，
 * 不再整行加载 `data` 大对象。字数仍按正文现算（content_text 即正文明文），
 * 不引入会漂移的派生列。
 */
export async function bookWordCounts(db: WordCountDb): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  const PAGE = 500;
  for (let offset = 0; ; offset += PAGE) {
    const result = await db.prepare(
      "SELECT json_extract(data, '$._microfeed.bookId') AS bookId, content_text " +
        "FROM items WHERE status = ? LIMIT ? OFFSET ?",
    ).bind(STATUSES.PUBLISHED, PAGE, offset).all();
    const rows = Array.isArray(result.results) ? result.results : [];
    if (rows.length === 0) break;
    for (const row of rows) {
      const bookId = typeof row["bookId"] === "string" ? (row["bookId"] as string).trim() : "";
      if (!bookId) continue;
      totals.set(bookId, (totals.get(bookId) ?? 0) + countBodyText(row["content_text"]));
    }
    if (rows.length < PAGE) break;
  }
  return totals;
}
