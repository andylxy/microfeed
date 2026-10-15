import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, localizedError} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {ensureMarkerCitations} from "@/server/tcm/markerPopover";
import {STATUSES, PERMISSION_CODES} from "@/shared/Constants";

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

/** One citing 条文 as the editor groups it: 书名 + 篇章名 → 条文号. */
interface CitingSection {
  id: string;
  status: number;
  title: string;
  chapterId: string;
  bookId: string;
  /** Sort key only, never serialised: the receiptNo rank of the old ORDER BY. */
  receiptRank: number;
}

/**
 * `GET ?name=<方剂名>&bookId=<书频道id>` — the 条文 (sections) that cite the
 * given 方剂.
 *
 * A section cites a fang through either the source `_microfeed.fangList`
 * (a JSON array of prescription names) or a `$f{方剂名}` marker inside its
 * body. Each row also carries its parent 篇章 (`tcm_parent_id`) and book
 * (`book_id`) so the fang editor can group the back-links as
 * 「书名 + 篇章名 → 条文号」 instead of a flat list of bare section numbers.
 *
 * `bookId` scopes the search to one book (the fang's own
 * `_microfeed.sourceBookId`) — several books have same-named formulas
 * (桂枝汤 ×4), and each book's editor page should only cite its own sections.
 *
 * 单书路径（编辑器默认场景）走 0111 的引用物化表 `ext_marker_citations` 点查，
 * 不再整书扫描 items：实测最大书 2964 行的旧扫描每次请求 ≈ 86 ms / 15.6 MB，
 * 点查 ≈ 0.01 ms。物化表是读者口径（`status IN (1,4)`，与 popover 同一份），
 * 草稿（status 2）不在其中，所以另有一条本书范围的草稿扫描补齐——旧查询的
 * `status != 3` 是含草稿的，编辑器视图不能因此漏看自己正在写的条文。
 * 缺 `bookId`（方剂没有 sourceBookId）时保留旧的全书扫描作兜底。
 *
 * 排序沿用旧的 `book_id, receiptNo, id`：物化行按 `section_seq` 取出后与草稿行
 * 合并，回表取 receiptNo（整数，与 SQL 数值序同口径）再排——与改造前同序。
 */
export const GET: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_CHAPTER_READ,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;

  const url = new URL(request.url);
  const name = (url.searchParams.get("name") ?? "").trim();
  if (!name) {
    return localizedError(request, "errors.fang.referencesNameMissing", 400);
  }
  const bookId = (url.searchParams.get("bookId") ?? "").trim();

  const escaped = escapeLike(name);
  const likePattern = `%$f{${escaped}}%`;
  const citingCondition =
    "tcm_kind = 'section' AND status != ? AND (" +
    "EXISTS (SELECT 1 FROM json_each(" +
    "json_extract(data, '$._microfeed.fangList')) WHERE json_each.value = ?) " +
    "OR data LIKE ? ESCAPE '\\')";

  let citing: CitingSection[] = [];
  let total = 0;

  if (bookId) {
    // 懒自举：脏了才重算（与 popover 同一机制，每变更周期一次而非每请求一次）。
    // 编辑器是这张表的新读者——不 ensure 就直接查，刚写完的条文会漏。
    await ensureMarkerCitations(env.FEED_DB, bookId);

    const {results} = await env.FEED_DB
      .prepare(
        "SELECT section_id, section_title FROM ext_marker_citations " +
          "WHERE book_id = ? AND marker_code = 'f' AND marker_name = ? " +
          "ORDER BY section_seq LIMIT 50",
      )
      .bind(bookId, name)
      .all<{section_id: string; section_title: string}>();
    const indexed = (results ?? []).map((row) => ({
      id: String(row.section_id),
      title: String(row.section_title),
    }));

    const counted = await env.FEED_DB
      .prepare(
        "SELECT count(*) AS total FROM ext_marker_citations " +
          "WHERE book_id = ? AND marker_code = 'f' AND marker_name = ?",
      )
      .bind(bookId, name)
      .first<{total: number}>();

    // 草稿补齐：本书范围内按 status=2 过滤（items_book_kind 覆盖索引步进，
    // 只为草稿行取表数据），谓词与旧扫描逐字一致。计数不带 LIMIT——旧查询的
    // total 是全量计数，编辑器底部「仅显示前 50 条」靠它对齐。
    const draftResult = await env.FEED_DB
      .prepare(
        "SELECT id, data, book_id, tcm_parent_id FROM items " +
          "WHERE book_id = ? AND tcm_kind = 'section' AND status = ? AND (" +
          "EXISTS (SELECT 1 FROM json_each(" +
          "json_extract(data, '$._microfeed.fangList')) WHERE json_each.value = ?) " +
          "OR data LIKE ? ESCAPE '\\') " +
          "ORDER BY book_id, json_extract(data, '$._microfeed.receiptNo'), id " +
          "LIMIT 50",
      )
      .bind(bookId, STATUSES.UNPUBLISHED, name, likePattern)
      .all<{
        id: string;
        data: string;
        book_id: string | null;
        tcm_parent_id: string | null;
      }>();
    const drafts = (draftResult.results ?? []).map((row) => ({
      id: String(row.id),
      title: titleOf(row.data),
      bookId: row.book_id ? String(row.book_id) : "",
      chapterId: row.tcm_parent_id ? String(row.tcm_parent_id) : "",
    }));
    const draftCount = await env.FEED_DB
      .prepare(
        "SELECT count(*) AS total FROM items " +
          "WHERE book_id = ? AND tcm_kind = 'section' AND status = ? AND (" +
          "EXISTS (SELECT 1 FROM json_each(" +
          "json_extract(data, '$._microfeed.fangList')) WHERE json_each.value = ?) " +
          "OR data LIKE ? ESCAPE '\\')",
      )
      .bind(bookId, STATUSES.UNPUBLISHED, name, likePattern)
      .first<{total: number}>();

    total = Number(counted?.total ?? 0) + Number(draftCount?.total ?? 0);
    citing = await mergeByReceiptNo(env.FEED_DB, indexed, drafts);
  } else {
    // 兜底：方剂没有 sourceBookId，跨书扫描（改造前的原路径）。
    const bindArgs = [STATUSES.DELETED, name, likePattern];
    const {results} = await env.FEED_DB
      .prepare(
        "SELECT id, status, data, book_id, tcm_parent_id FROM items " +
          `WHERE ${citingCondition} ` +
          "ORDER BY book_id, json_extract(data, '$._microfeed.receiptNo'), id " +
          "LIMIT 50",
      )
      .bind(...bindArgs)
      .all<{
        id: string;
        status: number;
        data: string;
        book_id: string | null;
        tcm_parent_id: string | null;
      }>();
    // SQL 已按 book_id, receiptNo, id 排好序；receiptRank 仅单书合并路径用。
    citing = (results ?? []).map((row) => ({
      id: String(row.id),
      status: Number(row.status),
      title: titleOf(row.data),
      chapterId: row.tcm_parent_id ? String(row.tcm_parent_id) : "",
      bookId: row.book_id ? String(row.book_id) : "",
      receiptRank: 0,
    }));

    const counted = await env.FEED_DB
      .prepare(`SELECT count(*) AS total FROM items WHERE ${citingCondition}`)
      .bind(...bindArgs)
      .first<{total: number}>();
    total = Number(counted?.total ?? 0);
  }

  // 篇章/书标题都存在 data JSON 里（items / channels 均无 title 列）；
  // 对去重后的 id 集合各做一次 IN 批量查询（≤50 parent、书数个位数，开销可忽略）。
  const parentIds = [
    ...new Set(citing.map((row) => row.chapterId).filter(Boolean)),
  ].map(String);
  const bookIds = [
    ...new Set(citing.map((row) => row.bookId).filter(Boolean)),
  ].map(String);
  const chapterTitles = await lookupDataTitles(env.FEED_DB, "items", parentIds);
  const bookTitles = await lookupDataTitles(env.FEED_DB, "channels", bookIds);

  const items = citing.map((row) => ({
    id: row.id,
    status: row.status,
    title: row.title,
    chapterId: row.chapterId,
    chapterTitle: chapterTitles.get(row.chapterId) ?? "",
    bookId: row.bookId,
    bookTitle: bookTitles.get(row.bookId) ?? "",
  }));
  return jsonResponse(
    {items, total},
    {headers: {"cache-control": "private, no-store"}},
  );
};

/** The item's `data.title`, or "" when the JSON is unreadable. */
function titleOf(data: string): string {
  try {
    const parsed = JSON.parse(data) as {title?: unknown};
    return typeof parsed.title === "string" ? parsed.title : "";
  } catch {
    // data is always valid JSON here; fall through to the id-only row.
    return "";
  }
}

/**
 * Merge the indexed (published/unlisted) rows with the draft rows into one
 * list ordered by the old scan's key — `book_id, receiptNo, id` — capped at 50.
 *
 * The citations table stores no receiptNo, so the indexed ids are fetched back
 * from `items` by primary key (≤ 50 + ≤ 50 rows) together with the columns the
 * response needs; the sort then runs in JS over that small set. receiptNo is an
 * integer in every section row, ranked numerically to match SQLite's ORDER BY;
 * an absent value ranks first, as SQL NULL does in ASC.
 */
async function mergeByReceiptNo(
  db: typeof env.FEED_DB,
  indexed: Array<{id: string; title: string}>,
  drafts: Array<{id: string; title: string; bookId: string; chapterId: string}>,
): Promise<CitingSection[]> {
  const ids = [...new Set([...indexed.map((r) => r.id), ...drafts.map((r) => r.id)])];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const {results} = await db
    .prepare(
      "SELECT id, status, book_id, tcm_parent_id, " +
        "json_extract(data, '$._microfeed.receiptNo') AS receipt_no " +
        `FROM items WHERE id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<{
      id: string;
      status: number;
      book_id: string | null;
      tcm_parent_id: string | null;
      receipt_no: number | null;
    }>();
  const byId = new Map((results ?? []).map((row) => [String(row.id), row]));
  const titleOfId = new Map([
    ...indexed.map((r) => [r.id, r.title] as const),
    ...drafts.map((r) => [r.id, r.title] as const),
  ]);

  const receiptRank = (value: number | null): number =>
    typeof value === "number" && Number.isFinite(value) ? value : -1;

  const merged: CitingSection[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) continue;
    merged.push({
      id,
      status: Number(row.status),
      title: titleOfId.get(id) ?? "",
      chapterId: row.tcm_parent_id ? String(row.tcm_parent_id) : "",
      bookId: row.book_id ? String(row.book_id) : "",
      receiptRank: receiptRank(row.receipt_no),
    });
  }
  merged.sort((a, b) => {
    if (a.bookId !== b.bookId) return a.bookId < b.bookId ? -1 : 1;
    if (a.receiptRank !== b.receiptRank) return a.receiptRank - b.receiptRank;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return merged.slice(0, 50);
}

/** 批量取 items/channels 的 `data.title`（两表均无 title 列，标题在 JSON 里）。 */
async function lookupDataTitles(
  db: typeof env.FEED_DB,
  table: "items" | "channels",
  ids: string[],
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  if (ids.length === 0) return titles;
  const placeholders = ids.map(() => "?").join(", ");
  const {results} = await db
    .prepare(
      `SELECT id, json_extract(data, '$.title') AS title FROM ${table} ` +
        `WHERE id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<{id: string; title: string | null}>();
  for (const row of results ?? []) {
    if (row.title) titles.set(String(row.id), row.title);
  }
  return titles;
}
