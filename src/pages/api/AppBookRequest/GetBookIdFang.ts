import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {jsonResponse} from "@/server/http";
import {
  APP_BOOK_FANG_CACHE,
  bookFangKeySuffix,
  cachedAppResponse,
} from "@/server/cache/app-cache";
import {getAppBookFang, tierFromAppMember, type AppNavTier} from "@/server/tcm/reads";

// 方剂随会员档分桶缓存（ADR-0048 D2）：会员书对公开档返回空也占公开桶，
// 书状态（会员切换）变更时由 extBook 写路径显式清两桶。
export const GET: APIRoute = async ({locals, url}) => {
  const bookId = url.searchParams.get("bookId") ?? "";
  const tier: AppNavTier = tierFromAppMember(locals.appMember);
  const keySuffix = bookId ? bookFangKeySuffix(bookId, tier) : null;
  if (!keySuffix) return jsonResponse({error: "missing bookId"}, {status: 400});
  return cachedAppResponse(
    APP_BOOK_FANG_CACHE,
    () => getAppBookFang(env.FEED_DB, bookId, tier),
    keySuffix,
  );
};
