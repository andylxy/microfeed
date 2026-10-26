import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {adminUrl} from "@/shared/AdminPath";
import type {ItemSearchStatus} from "@/shared/ItemSearch";
import FeedDb from "@/server/feed/FeedDb";
import {
  latestAdminItems,
  searchAdminItems,
} from "@/server/admin/item-search";
import {jsonResponse} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

const ALL_STATUSES: ItemSearchStatus[] = [
  "published",
  "unlisted",
  "unpublished",
];

export async function getAdminItemSearch(
  request: Request,
  runtimeEnv: Env,
  adminPath: string,
): Promise<Response> {
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  const database = new FeedDb(runtimeEnv, request);
  const items = query.length >= 2
    ? await searchAdminItems(database.FEED_DB, {
        limit: 5,
        query,
        statuses: ALL_STATUSES,
      })
    : query.length === 0
      ? await latestAdminItems(database.FEED_DB, ALL_STATUSES, 5)
      : [];
  return jsonResponse({
    items: items.map((item) => ({
      edit_url: adminUrl(`items/${item.id}`, adminPath),
      date_published: item.date_published,
      highlights: item.highlights.title,
      id: item.id,
      match_type: item.match_type,
      status: item.status,
      title: item.title,
      updated_at: item.date_modified,
    })),
  }, {headers: {"cache-control": "private, no-store"}});
}

export const GET: APIRoute = async ({locals, params, request}) => {
  // B26: admin search reads item content, so the chapter-read code guards it.
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_CHAPTER_READ, request, env.FEED_DB);
  if (guard) return guard;
  return getAdminItemSearch(request, env, params.adminPath ?? "admin");
};
