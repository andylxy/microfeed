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
 *
 * ## 为什么这里还有一张物化表
 *
 * 「每本书多少字」是**该书所有条目正文字数之和**——一个聚合，不是任何一行的
 * 字段。本地实测：要产出 13 个数字，必须读 9,506 行正文（首页 9,547 行读、
 * 后台 9,523 行读，产出都只有 13 个数字）。
 *
 * 这是语义决定的，索引修不了：加索引不加不减（9,506 是「**必须**读的行」，不是
 * 「找不到的行」）；一条 SQL `GROUP BY` 实测 **19,012** 行读，比逐本读更贵；
 * `ANALYZE` 实测负收益。唯一出路是**不再每次重算**——把答案存进
 * `ext_book_stats`（迁移 0103），由 `items` 上的触发器做失效，读路径懒自举。
 *
 * 稳态下首页/后台各只读 **12 行**；某本书被编辑后，只有那本书重算一次。
 */

export interface WordCountDbPreparedStatement {
  bind(...values: unknown[]): WordCountDbPreparedStatement;
  all(): Promise<{results: Record<string, unknown>[]}>;
  /** 懒自举要写回物化表，所以这个端口必须能写。 */
  run(): Promise<unknown>;
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

/** 每页读多少行。keyset 游标翻页的步长——只影响往返次数，**不影响总行读**。 */
export const PAGE_SIZE = 500;

/**
 * `items` 上的两种前置谓词，决定这次读走哪个索引。
 *
 * - `status = ?`（公开口径）配 `book_id` 走 `items_book_id`，配 rowid 走 `items_status`；
 * - `status != ?`（后台口径：连草稿一起算）用不上索引前缀，退化为按 rowid 顺序读表。
 */
export interface ItemScope {
  /** 完整谓词片段，只允许 `status = ?` 或 `status != ?`。 */
  predicate: string;
  /** 该谓词的绑定值。 */
  status: number;
}

/** 公开站口径：只算已发布条目。 */
export const PUBLISHED_ITEM_SCOPE: ItemScope = {
  predicate: "status = ?",
  status: STATUSES.PUBLISHED,
};

/** 后台口径：连草稿一起算，只排除已软删除。 */
export const NON_DELETED_ITEM_SCOPE: ItemScope = {
  predicate: "status != ?",
  status: STATUSES.DELETED,
};

/**
 * 把可选的 `bookIds` 归一成「要遍历的目标列表」：`[null]` = 整库一遍，
 * 具体 id 数组 = 逐本收束，空数组 = 什么都不读（调用方直接返回空结果）。
 */
export function resolveScopedTargets(
  bookIds?: string[],
): Array<string | null> {
  if (bookIds === undefined) return [null];
  return bookIds
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/**
 * 逐行读 `items`，把每一行交给 `visit`。
 *
 * **整库（`bookId === null`）：rowid 游标分页，不用 `LIMIT ? OFFSET ?`**
 * D1 的 `rows_read` 按**步进行数**计费：OFFSET 取第 k 页要先把前 k×PAGE_SIZE 行
 * 走一遍，总代价随页数**二次方**增长。实测读 9,506 行的表，20 页 OFFSET 累计
 * **104,506** 行读（表的 11 倍）；同一个结果集换成 rowid 游标只要 **9,506** 行读。
 * 表越大差距越大——5M 行/日的免费额度下，OFFSET 版首页约 **48 次请求**就耗尽。
 *
 * 游标列用 `rowid` 而不是 `id`：`items.id` 是随机短 UUID，按它排序拿不到任何索引
 * 顺序。`rowid` 是表序，`status = ?` 命中 `items_status (status)`、`status != ?`
 * 退化为 `INTEGER PRIMARY KEY` 扫描，两种情况下 `rowid > ?` 都是索引范围条件，
 * 因此**不需要** TEMP B-TREE。
 *
 * **单本（`bookId !== null`）：一次读完，不叠分页**
 * 这本书的条目数就是成本下界，`book_id` 索引 seek 已经落在该下界上。再叠分页只会
 * 变差：加 `ORDER BY rowid` 会引入临时排序（`items_book_id` 在 `status != ?` 时只
 * 能用 `book_id` 当前缀，rowid 退化为过滤条件 —— 实测单本 174 → **347** 行读）；
 * 换成 `LIMIT ? OFFSET ?` 又回到二次方。行的顺序与聚合无关，所以不排序、不分页。
 */
export async function forEachItem(
  db: WordCountDb,
  scope: ItemScope,
  bookId: string | null,
  visit: (row: Record<string, unknown>) => void,
): Promise<void> {
  const columns =
    "status, json_extract(data, '$._microfeed.bookId') AS bookId, content_text";

  if (bookId !== null) {
    const result = await db
      .prepare(
        `SELECT ${columns} FROM items WHERE ${scope.predicate} AND book_id = ?`,
      )
      .bind(scope.status, bookId)
      .all();
    const rows = Array.isArray(result.results) ? result.results : [];
    for (const row of rows) visit(row);
    return;
  }

  const sql = `SELECT rowid AS rid, ${columns} FROM items ` +
    `WHERE ${scope.predicate} AND rowid > ? ORDER BY rowid LIMIT ?`;
  let cursor = 0;
  for (;;) {
    const result = await db
      .prepare(sql)
      .bind(scope.status, cursor, PAGE_SIZE)
      .all();
    const rows = Array.isArray(result.results) ? result.results : [];
    if (rows.length === 0) break;
    for (const row of rows) visit(row);
    if (rows.length < PAGE_SIZE) break;
    const last = rows[rows.length - 1];
    if (last === undefined) break;
    cursor = Number(last["rid"]);
  }
}

/** 一本书的物化统计。两种口径并存：公开站只算已发布，后台要连草稿一起算。 */
export interface BookStatRow {
  bookId: string;
  /** 公开口径：`status = 1` 的条目数与字数之和。 */
  chaptersPublished: number;
  wordsPublished: number;
  /** 后台口径：`status != 3` 的条目数与字数之和。 */
  chaptersAll: number;
  wordsAll: number;
}

/** 带过期标记的内部行：`computedAtMs === 0` 表示触发器把它标成了过期。 */
interface StoredStatRow extends BookStatRow {
  computedAtMs: number;
}

const STATS_TABLE = "ext_book_stats";
const STATS_COLUMNS =
  "book_id, chapters_published, words_published, chapters_all, words_all, computed_at_ms";
const STATS_UPSERT =
  `INSERT INTO ${STATS_TABLE} (${STATS_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?) ` +
  "ON CONFLICT(book_id) DO UPDATE SET " +
  "chapters_published = excluded.chapters_published, " +
  "words_published = excluded.words_published, " +
  "chapters_all = excluded.chapters_all, " +
  "words_all = excluded.words_all, " +
  "computed_at_ms = excluded.computed_at_ms";

function asCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stripMarker(row: StoredStatRow): BookStatRow {
  return {
    bookId: row.bookId,
    chaptersPublished: row.chaptersPublished,
    wordsPublished: row.wordsPublished,
    chaptersAll: row.chaptersAll,
    wordsAll: row.wordsAll,
  };
}

/**
 * 重算一本书并写回物化表。
 *
 * 走后台口径（`status != 3`）**一遍**，顺带把已发布的那部分拆出来——
 * 两种口径共用同一次扫描，不必扫两遍。
 */
export async function refreshBookStats(
  db: WordCountDb,
  bookId: string,
  computedAtMs = Date.now(),
): Promise<BookStatRow> {
  let chaptersPublished = 0;
  let wordsPublished = 0;
  let chaptersAll = 0;
  let wordsAll = 0;
  await forEachItem(db, NON_DELETED_ITEM_SCOPE, bookId, (row) => {
    const words = countBodyText(row["content_text"]);
    chaptersAll += 1;
    wordsAll += words;
    if (asCount(row["status"]) === STATUSES.PUBLISHED) {
      chaptersPublished += 1;
      wordsPublished += words;
    }
  });
  await db
    .prepare(STATS_UPSERT)
    .bind(bookId, chaptersPublished, wordsPublished, chaptersAll, wordsAll, computedAtMs)
    .run();
  return {bookId, chaptersPublished, wordsPublished, chaptersAll, wordsAll};
}

async function selectStoredStats(db: WordCountDb): Promise<StoredStatRow[]> {
  const result = await db
    .prepare(`SELECT ${STATS_COLUMNS} FROM ${STATS_TABLE}`)
    .all();
  const rows = Array.isArray(result.results) ? result.results : [];
  return rows
    .map((row) => ({
      bookId: String(row["book_id"] ?? ""),
      chaptersPublished: asCount(row["chapters_published"]),
      wordsPublished: asCount(row["words_published"]),
      chaptersAll: asCount(row["chapters_all"]),
      wordsAll: asCount(row["words_all"]),
      computedAtMs: asCount(row["computed_at_ms"]),
    }))
    .filter((row) => row.bookId.length > 0);
}

/** 表里一行都没有 = 从未建过。补一次全量，之后都走增量。 */
async function bootstrapAllBooks(
  db: WordCountDb,
  stored: Map<string, StoredStatRow>,
): Promise<void> {
  const result = await db
    .prepare(
      "SELECT DISTINCT book_id FROM items WHERE status != ? AND book_id IS NOT NULL",
    )
    .bind(STATUSES.DELETED)
    .all();
  const rows = Array.isArray(result.results) ? result.results : [];
  for (const row of rows) {
    const bookId = String(row["book_id"] ?? "").trim();
    if (!bookId) continue;
    stored.set(bookId, {...await refreshBookStats(db, bookId), computedAtMs: 1});
  }
}

const isFresh = (row: StoredStatRow | undefined): row is StoredStatRow =>
  row !== undefined && row.computedAtMs !== 0;

/**
 * 读每本书的物化统计。**缺失或过期的书当场重算一次并写回**（懒自举），
 * 所以新部署不需要回填步骤，触发器标过的过期行也会在第一次被读到时自愈。
 *
 * 稳态成本：整表读 = 频道数（本地 13）行。
 */
export async function readBookStats(
  db: WordCountDb,
  bookIds?: string[],
): Promise<Map<string, BookStatRow>> {
  const targets = resolveScopedTargets(bookIds);
  if (targets.length === 0) return new Map();

  const stored = new Map<string, StoredStatRow>();
  for (const row of await selectStoredStats(db)) stored.set(row.bookId, row);

  if (targets[0] === null) {
    if (stored.size === 0) await bootstrapAllBooks(db, stored);
    for (const [bookId, row] of [...stored]) {
      if (!isFresh(row)) {
        stored.set(bookId, {...await refreshBookStats(db, bookId), computedAtMs: 1});
      }
    }
    return new Map(
      [...stored].map(([bookId, row]) => [bookId, stripMarker(row)]),
    );
  }

  const result = new Map<string, BookStatRow>();
  for (const bookId of targets as string[]) {
    const row = stored.get(bookId);
    result.set(
      bookId,
      isFresh(row) ? stripMarker(row) : await refreshBookStats(db, bookId),
    );
  }
  return result;
}

/**
 * Word count per book, summed over its published chapters.
 *
 * 读 `ext_book_stats` 的物化结果（见文件头「为什么这里还有一张物化表」），
 * 缺失或过期的书当场重算一次。只返回**有已发布条目**的书——与旧的「扫 items
 * 按 bookId 分组」口径一致：没有已发布条目的书不会出现在结果里。
 *
 * `bookIds` 收束到指定书；省略则返回表里所有书。传空数组直接返回空 Map。
 */
export async function bookWordCounts(
  db: WordCountDb,
  bookIds?: string[],
): Promise<Map<string, number>> {
  const stats = await readBookStats(db, bookIds);
  const totals = new Map<string, number>();
  for (const [bookId, row] of stats) {
    if (row.chaptersPublished > 0) totals.set(bookId, row.wordsPublished);
  }
  return totals;
}
