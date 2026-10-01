import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, localizedError} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {STATUSES, PERMISSION_CODES} from "@/shared/Constants";

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

/**
 * `GET ?name=<方剂名>` — the 条文 (sections) that cite the given 方剂.
 *
 * A section cites a fang through either the source `_microfeed.fangList`
 * (a JSON array of prescription names) or a `$f{方剂名}` marker inside its
 * body. Returns a compact list so the fang editor can show "which 条文
 * reference this prescription" as a back-link view.
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

  const escaped = escapeLike(name);
  const {results} = await env.FEED_DB
    .prepare(
      "SELECT id, status, data FROM items " +
        "WHERE tcm_kind = 'section' AND status != ? AND (" +
        "EXISTS (SELECT 1 FROM json_each(" +
        "json_extract(data, '$._microfeed.fangList')) WHERE json_each.value = ?) " +
        "OR data LIKE ? ESCAPE '\\') " +
        "ORDER BY book_id, json_extract(data, '$._microfeed.receiptNo'), id " +
        "LIMIT 50",
    )
    .bind(STATUSES.DELETED, name, `%$f{${escaped}}%`)
    .all<{id: string; status: number; data: string}>();

  const items = (results ?? []).map((row) => {
    let title = "";
    try {
      const parsed = JSON.parse(row.data) as {title?: unknown};
      title = typeof parsed.title === "string" ? parsed.title : "";
    } catch {
      // data is always valid JSON here; fall through to the id-only row.
    }
    return {id: String(row.id), status: Number(row.status), title};
  });
  return jsonResponse(
    {items},
    {headers: {"cache-control": "private, no-store"}},
  );
};
