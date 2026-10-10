import {D1_MAX_BOUND_PARAMS, STATUSES} from "@/shared/Constants";
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

/** 每条语句读多少行。没有它，一本书上万章会一次全塞进一个响应里。 */
export const PAGE_SIZE = 500;

/** 与 `IN (...)` 共用同一批绑定的占位符个数：`status` / `LIMIT` / `OFFSET`。 */
export const IN_CLAUSE_RESERVED_BINDS = 3;

/**
 * 把 id 列表切片，保证单条语句不超出 D1 的位置参数上限。
 * `reserved` 是同一条语句里其余绑定的个数。
 */
export function chunkWithinD1BindLimit(
  ids: string[],
  reserved = 0,
): string[][] {
  const size = Math.max(1, D1_MAX_BOUND_PARAMS - reserved);
  const out: string[][] = [];
  for (let start = 0; start < ids.length; start += size) {
    out.push(ids.slice(start, start + size));
  }
  return out;
}

/**
 * Word count per book, summed over its published chapters.
 *
 * 按 D1 官方建议只投影所需列（bookId 表达式 + content_text），并分页流式读取，
 * 不再整行加载 `data` 大对象。字数仍按正文现算（content_text 即正文明文），
 * 不引入会漂移的派生列。
 *
 * `bookIds` 把扫描范围从「全库 published」收敛到指定书，走 `items_book_id`
 * 索引（`WHERE status = ? AND book_id IN (...)` 两个谓词都在索引里，规划器才
 * 稳定选它而不是 `items_status_*`）。⚠️ 这个收益依赖 0097 把 `items_book_id`
 * 重建为 `(book_id, status)`；若 0097 被回滚，收束会退化成残余过滤、耗时反而
 * 变差，两处改动必须一起上/一起撤。省略 `bookIds` 时保留原来的全库口径。
 * 传空数组直接返回空 Map，不发起查询——`IN ()` 在 SQLite 里是语法错误。
 *
 * 每片最多 `D1_MAX_BOUND_PARAMS - 3` 个 id：`status` / `LIMIT` / `OFFSET` 已占
 * 3 个绑定位，D1 单条语句最多 100 个位置参数。
 */
export async function bookWordCounts(
  db: WordCountDb,
  bookIds?: string[],
): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  const scoped = bookIds !== undefined;
  const ids = bookIds
    ?.map((id) => id.trim())
    .filter((id) => id.length > 0) ?? [];
  if (scoped && ids.length === 0) return totals;

  const chunks = chunkWithinD1BindLimit(ids, IN_CLAUSE_RESERVED_BINDS);
  // `chunks` 在「未收束」和「ids 为空」时都是空的；补进的那个空片正好就是
  // 原本不带 `book_id` 谓词的语句。
  if (chunks.length === 0) chunks.push([]);

  for (const chunk of chunks) {
    const placeholders = chunk.map(() => "?").join(",");
    const sql =
      "SELECT json_extract(data, '$._microfeed.bookId') AS bookId, content_text " +
      "FROM items WHERE status = ?" +
      (placeholders ? ` AND book_id IN (${placeholders})` : "") +
      " LIMIT ? OFFSET ?";
    // 每个分片都要有自己的 OFFSET 走读；漏掉会把 PAGE_SIZE 之后的行静默截断。
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const result = await db
        .prepare(sql)
        .bind(STATUSES.PUBLISHED, ...chunk, PAGE_SIZE, offset)
        .all();
      const rows = Array.isArray(result.results) ? result.results : [];
      for (const row of rows) {
        const bookId = typeof row["bookId"] === "string"
          ? (row["bookId"] as string).trim()
          : "";
        if (!bookId) continue;
        totals.set(bookId, (totals.get(bookId) ?? 0) + countBodyText(row["content_text"]));
      }
      if (rows.length < PAGE_SIZE) break;
    }
  }
  return totals;
}
