import {appEnvelope} from "@/server/tcm/envelope";
import {jsonResponse} from "@/server/http";

/**
 * App 公共数据端点的服务端缓存。
 *
 * 这些端点（GetAllZhongYao / GetAliaZhongYao / GetNav）返回全库公共数据，
 * 内容与调用者身份无关，但调用方都带 Bearer 凭证，
 * `applyWorkerCachePolicy` 因此把它们强制成 `private, no-store`——
 * 源码里写的 `public, max-age=300` 从未生效，每次请求都打 D1。
 *
 * 这里用 Worker 内的 Cache API 自管缓存：key 是固定的内部 URL（不含用户身份，
 * 不同用户共享同一份），TTL 300 秒。命中直接回包，未命中才走 D1 并回填。
 * 鉴权仍由端点之前的逻辑负责，缓存只省数据库读取。
 *
 * `GetAllMingCi` 不走这里：它的返回随调用者权限变化（有码全量、无码空数组），
 * 共享缓存会把有码用户的数据吐给无码用户。
 */
const APP_CACHE_TTL = 300;
const APP_CACHE_ORIGIN = "https://app-cache.microfeed.internal";

/** Workers 运行时 Cache Storage 的最小接口（`caches.default`，按 URL 存取）。 */
interface WorkerCache {
  match(request: URL | Request): Promise<Response | undefined>;
  put(request: URL | Request, response: Response): Promise<void>;
}

function appCache(): WorkerCache {
  // `caches.default` 是 Workers 运行时的全局 Cache Storage；
  // 标准类型里没有这个成员，这里用最小接口收窄。
  const storage = (globalThis as {caches?: {default?: WorkerCache}}).caches;
  if (!storage?.default) {
    throw new Error("Cache Storage unavailable in this runtime");
  }
  return storage.default;
}

export async function cachedAppResponse(
  cacheName: string,
  load: () => Promise<unknown>,
): Promise<Response> {
  const key = new URL(`/app/${cacheName}`, APP_CACHE_ORIGIN);
  let hit: Response | undefined;
  try {
    hit = await appCache().match(key);
  } catch {
    hit = undefined;
  }
  if (hit) return hit;
  const response = jsonResponse(appEnvelope(await load()), {
    headers: {"cache-control": `public, max-age=${APP_CACHE_TTL}`},
  });
  try {
    await appCache().put(key, response.clone());
  } catch {
    // 缓存写入失败（本地 dev / 权限受限）不阻塞响应，退化为直连 D1。
  }
  return response;
}
