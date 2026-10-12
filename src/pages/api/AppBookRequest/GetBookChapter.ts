import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {jsonResponse} from "@/server/http";
import {cachedAppResponse} from "@/server/tcm/app-cache";
import {getAppBookChapters} from "@/server/tcm/reads";

// 此前手写的 `cache-control: public, max-age=300` 从未生效过——`applyWorkerCachePolicy`
// 在中间件里把所有 `/api/*` 强制成 `private, no-store`（`isSensitivePath`）。走
// `cachedAppResponse` 的 Worker 级共享缓存才能真正省掉这次 D1 读取。
//
// 可共享的前提已核对：`getAppBookChapters` 只返回 `bookId / chapterSection /
// chapterHeader / signatureId` 四个精简字段（`reads.ts:364-387`），不含正文、
// 不含调用者身份，SQL 也只取 `status = 1`。与身份无关 ⇒ 键按 bookId 分份、
// 全体用户共用一份是安全的。
//
// 实测代价（2026-10-11 快照，F5 迁移后）：约 163 行/次未命中。按 13 本书、
// 每本每天一次失效估算，163 × 13 ≈ 2.1K 行/日，额度占比可忽略；但它是三个
// 「已缓存」的 App 端点里唯一漏掉的那个，且 App 打开一本圣经典就打一次，
// 故一并纳入。
export const GET: APIRoute = async ({url}) => {
  const bookId = url.searchParams.get("bookId") ?? "";
  if (!bookId) return jsonResponse({error: "missing bookId"}, {status: 400});
  return cachedAppResponse(
    "book-chapters",
    () => getAppBookChapters(env.FEED_DB, bookId),
    bookId,
  );
};
