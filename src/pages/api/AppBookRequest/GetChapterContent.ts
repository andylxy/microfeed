import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {jsonResponse} from "@/server/http";
import {
  APP_CHAPTER_CONTENT_CACHE,
  cachedAppResponse,
  chapterContentKeySuffix,
} from "@/server/cache/app-cache";
import {getAppChapterContent, tierFromAppMember, type AppNavTier} from "@/server/tcm/reads";

// 两层门（ADR-0044）：访问门按书本状态——会员书只对会员档放行，公开档返回空数组；
// 内容门按调用方会员档——附注（note）与视频讲解（sectionvideo）是会员权益，
// 会员档照发原始值、公开档置空。`applyWorkerCachePolicy` 已把 `/api/*` 强制成
// `private, no-store`，两档差异不会被中间层缓存串味；端点自身的缓存是 Worker 内
// app-cache（ADR-0048 D2），tier 进键、两只桶分开，编辑/书状态变更显式清桶。
export const GET: APIRoute = async ({locals, url}) => {
  // The legacy app calls this endpoint with the old .NET backend's parameter
  // names — `bookId` (channel) + `contentId` (chapter section) + `signatureId`
  // (the chapter id it received from GetBookChapter) — whereas the golden
  // capture tool uses the microfeed-native `chapterId`. Both carry the chapter's
  // 11-char id, so accept either; the app's `signatureId` is the one that must
  // keep working (it was rejected with 400 before, breaking the reader).
  const chapterId = url.searchParams.get("chapterId") ??
    url.searchParams.get("signatureId") ?? "";
  const tier: AppNavTier = tierFromAppMember(locals.appMember);
  const keySuffix = chapterId ? chapterContentKeySuffix(chapterId, tier) : null;
  if (!keySuffix) return jsonResponse({error: "missing chapterId"}, {status: 400});
  return cachedAppResponse(
    APP_CHAPTER_CONTENT_CACHE,
    () => getAppChapterContent(env.FEED_DB, chapterId, tier),
    keySuffix,
  );
};
