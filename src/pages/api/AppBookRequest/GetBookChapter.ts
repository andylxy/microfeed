import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {jsonResponse} from "@/server/http";
import {
  APP_BOOK_CHAPTERS_CACHE,
  bookChaptersKeySuffix,
  cachedAppResponse,
} from "@/server/cache/app-cache";
import {getAppBookChapters, tierFromAppMember, type AppNavTier} from "@/server/tcm/reads";

// 此前手写的 `cache-control: public, max-age=300` 从未生效过——`applyWorkerCachePolicy`
// 在中间件里把所有 `/api/*` 强制成 `private, no-store`（`isSensitivePath`）。走
// `cachedAppResponse` 的 Worker 级共享缓存才能真正省掉这次 D1 读取。
//
// 可共享的前提已核对：`getAppBookChapters` 只返回 `bookId / chapterSection /
// chapterHeader / signatureId` 四个精简字段，不含正文、不含调用者身份。目录内容
// 随「是否会员」变化（会员书的目录只给会员），所以键按 `<bookId>:<tier>` 分份——
// 同一档位的用户共享一份，仍不区分具体是谁。
//
// 实测代价（2026-10-11 快照，F5 迁移后）：约 163 行/次未命中。按 13 本书、
// 每本每天一次失效估算，163 × 13 ≈ 2.1K 行/日，额度占比可忽略。
export const GET: APIRoute = async ({locals, url}) => {
  const bookId = url.searchParams.get("bookId") ?? "";
  if (!bookId) return jsonResponse({error: "missing bookId"}, {status: 400});
  const tier: AppNavTier = tierFromAppMember(locals.appMember);
  // bookId 是查询参数、要进缓存键：先过白名单，含 `/` `?` `#` `:` 之类的一律
  // 400——放行会让 URL 归一化改写键的写法，用一个键换掉另一本书的缓存条目。
  const keySuffix = bookChaptersKeySuffix(bookId, tier);
  if (keySuffix === null) {
    return jsonResponse({error: "invalid bookId"}, {status: 400});
  }
  return cachedAppResponse(
    APP_BOOK_CHAPTERS_CACHE,
    () => getAppBookChapters(env.FEED_DB, bookId, tier),
    keySuffix,
  );
};
