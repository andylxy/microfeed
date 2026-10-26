/**
 * 控制面「清空」动作（方案 5.6）。
 *
 * `caches.default` 没有 deleteAll，也没有按前缀删除；跨机房生效只有
 * `cache.purge({tags})` 一条路。条目在写缓存时带两条标签：总标签
 * `APP_CACHE_TAG` 与分桶标签 `${APP_CACHE_TAG}:${bucket}`，见
 * `app-cache.ts` / `identity-cache.ts` 的写入口。
 *
 * 清空计入日预算：一次全清约 22,013 行回源读，10 秒节流最坏 8,640 次/日会把
 * 当天读额度打空，所以先记一次再清（`noteAppCachePurged`，30 次/日上限）。
 * 计数发生在请求受理前：purge 失败也算一次尝试，避免失败时反复重试绕过预算。
 */

import {cache} from "cloudflare:workers";

import {
  APP_CACHE_BUCKETS,
  type AppCacheBucket,
  type AppCacheControl,
} from "@/shared/AppCacheControl";
import {APP_CACHE_TAG, noteAppCachePurged} from "./cache-control";

export type AppCachePurgeScope = AppCacheBucket | "all";

export type AppCachePurgeResult =
  | {ok: true; tags: string[]; control: AppCacheControl}
  | {
      ok: false;
      reason: "throttled" | "dailyLimit" | "purgeFailed";
      retryAfterMs: number;
      errors: string[];
    };

const BUCKET_SET: ReadonlySet<string> = new Set(APP_CACHE_BUCKETS);

/** 请求体里的 scope：缺省是「全部」，其余必须是登记过的桶名。 */
export function isAppCachePurgeScope(value: unknown): value is AppCachePurgeScope {
  return value === "all"
    || (typeof value === "string" && BUCKET_SET.has(value));
}

/** 清空动作对应的标签。全部清空只用总标签，单桶用分桶标签。 */
export function appCachePurgeTags(scope: AppCachePurgeScope): string[] {
  return scope === "all" ? [APP_CACHE_TAG] : [`${APP_CACHE_TAG}:${scope}`];
}

export async function purgeAppCache(
  scope: AppCachePurgeScope,
): Promise<AppCachePurgeResult> {
  const gate = await noteAppCachePurged();
  if (!gate.allowed) {
    return {
      errors: [],
      ok: false,
      reason: gate.retryAfterMs > 0 ? "throttled" : "dailyLimit",
      retryAfterMs: gate.retryAfterMs,
    };
  }
  const tags = appCachePurgeTags(scope);
  let purged: Awaited<ReturnType<typeof cache.purge>>;
  try {
    purged = await cache.purge({tags});
  } catch (error) {
    // 本地 dev 的 miniflare 不支持 purge 时抛错；把原始信息带回页面，
    // 运营能直接看到「为什么没清」。
    return {
      errors: [error instanceof Error ? error.message : String(error)],
      ok: false,
      reason: "purgeFailed",
      retryAfterMs: 0,
    };
  }
  if (!purged.success) {
    return {
      errors: purged.errors.map((entry) => `${entry.code}: ${entry.message}`),
      ok: false,
      reason: "purgeFailed",
      retryAfterMs: 0,
    };
  }
  return {control: gate.control, ok: true, tags};
}
