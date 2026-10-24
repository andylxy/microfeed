import {cache} from "cloudflare:workers";

import FeedDb from "@/server/feed/FeedDb";
import {PUBLIC_CACHE_TAGS} from "@/server/cache/public-cache";
import {purgeAppChapterContentCache} from "@/server/cache/app-cache";
/**
 * raw-SQL 定稿写回（`writeItemContent` 系：评审批准、纠错定稿、中药/术语
 * 重写）绕过 `FeedCrudManager` 保存路径，CDN Cache-Tag 与 App 章节正文桶都
 * 不会自动失效（ADR-0049 D3）——这里补齐：写在调用方已提交之后调用本函数。
 *
 * CDN 覆盖公开页 / 条目页 / feed / 主频道；App 桶按 tcm_kind 收窄——
 * chapter 直清两档，section 清其所属章两档（TCM 章节正文），yao/term 等
 * 其他 kind 没有 App 桶。
 */
export async function purgeWritebackCaches(
  runtimeEnv: Env,
  request: Request,
  itemId: string,
): Promise<void> {
  const database = new FeedDb(runtimeEnv, request, cache);
  await database.purgePublicCacheTags([
    PUBLIC_CACHE_TAGS.PUBLIC,
    PUBLIC_CACHE_TAGS.ITEMS,
    PUBLIC_CACHE_TAGS.CHANNEL_PRIMARY,
    PUBLIC_CACHE_TAGS.item(itemId),
  ]);
  const row = await (database.FEED_DB as D1Database).prepare(
    "SELECT tcm_kind AS kind, tcm_parent_id AS parentId FROM items WHERE id = ?",
  ).bind(itemId).first<{kind: string | null; parentId: string | null}>();
  if (!row) return;
  if (row.kind === "chapter") {
    await purgeAppChapterContentCache(itemId);
  } else if (row.kind === "section" && row.parentId) {
    await purgeAppChapterContentCache(row.parentId);
  }
}
