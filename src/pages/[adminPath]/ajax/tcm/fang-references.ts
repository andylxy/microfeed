import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, localizedError} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {STATUSES, PERMISSION_CODES} from "@/shared/Constants";

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
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
  // bindArgs 用 any[] 以携带可选的 bookId 过滤参数（D1 bind 为变参）。
  const bindArgs: any[] = [STATUSES.DELETED, name, `%$f{${escaped}}%`];
  let citingCondition =
    "tcm_kind = 'section' AND status != ? AND (" +
    "EXISTS (SELECT 1 FROM json_each(" +
    "json_extract(data, '$._microfeed.fangList')) WHERE json_each.value = ?) " +
    "OR data LIKE ? ESCAPE '\\')";
  if (bookId) {
    citingCondition += " AND book_id = ?";
    bindArgs.push(bookId);
  }

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

  // 引用总数：分组视图底部提示「仅显示前 50 条」用。
  const total = await env.FEED_DB
    .prepare(`SELECT count(*) AS total FROM items WHERE ${citingCondition}`)
    .bind(...bindArgs)
    .first<{total: number}>();

  // 篇章/书标题都存在 data JSON 里（items / channels 均无 title 列）；
  // 对去重后的 id 集合各做一次 IN 批量查询（≤50 parent、书数个位数，开销可忽略）。
  const parentIds = [
    ...new Set(results.map((row) => row.tcm_parent_id).filter(Boolean)),
  ].map(String);
  const bookIds = [
    ...new Set(results.map((row) => row.book_id).filter(Boolean)),
  ].map(String);
  const chapterTitles = await lookupDataTitles(env.FEED_DB, "items", parentIds);
  const bookTitles = await lookupDataTitles(env.FEED_DB, "channels", bookIds);

  const items = (results ?? []).map((row) => {
    let title = "";
    try {
      const parsed = JSON.parse(row.data) as {title?: unknown};
      title = typeof parsed.title === "string" ? parsed.title : "";
    } catch {
      // data is always valid JSON here; fall through to the id-only row.
    }
    return {
      id: String(row.id),
      status: Number(row.status),
      title,
      chapterId: row.tcm_parent_id ? String(row.tcm_parent_id) : "",
      chapterTitle: chapterTitles.get(String(row.tcm_parent_id)) ?? "",
      bookId: row.book_id ? String(row.book_id) : "",
      bookTitle: bookTitles.get(String(row.book_id)) ?? "",
    };
  });
  return jsonResponse(
    {items, total: total?.total ?? items.length},
    {headers: {"cache-control": "private, no-store"}},
  );
};

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
