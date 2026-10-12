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
 * 不同用户共享同一份）。命中直接回包，未命中才走 D1 并回填。
 * 鉴权仍由端点之前的逻辑负责，缓存只省数据库读取。
 *
 * `GetAllMingCi` 不走这里：它的返回随调用者权限变化（有码全量、无码空数组），
 * 共享缓存会把有码用户的数据吐给无码用户。
 *
 * TTL 是 86400 秒（24h）而不是 300 秒，理由是未命中上限的算术：
 * `caches.default` 的内容**不跨数据中心复制**（CF 文档），且 `cache.put`/`match`
 * **不支持 `stale-while-revalidate` / `stale-if-error`**（同为 CF 文档实测），所以
 * 一个 URL 的每日未命中次数 = `min(当日请求数 R, 86400/TTL × POP 数 P)`。
 * TTL=300s、P=3 时上限 = 864，即单 URL 每天要 >864 次请求才开始受益；中医站
 * 的「全库中药」这类键远达不到，等于每次请求都打 D1。
 *
 * 实测代价（2026-10-11 快照）：`getAppAllYao` 1,385 行 + `getDerivedYaoAliases`
 * 1,275 行 = 2,660 行/次未命中。按 App 日 400 次调用估算，300s TTL ≈ 1.06M 行/日
 * = 免费额度的 21%；24h TTL 降到 2 次 × 2,660 ≈ 5.3K 行/日。
 *
 * 陈旧上限 24h 是已接受的取舍：这些端点返回的是已出版典籍的静态目录，人工编辑
 * 频率远低于读频率，与公开书页的边缘缓存 TTL 保持一致。
 */
const APP_CACHE_TTL = 86400;
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

/**
 * `keySuffix` 给「同一逻辑端点、多份不同内容」用：`caches.default` 的键是完整
 * URL，把 bookId 之类拼进路径就能按参数分份共享键，而仍然不含调用者身份
 * （不同用户命中同一份，与身份无关才安全；身份相关的端点禁止进来）。
 * 现有三个端点不带后缀，行为与之前逐字一致。
 */
export async function cachedAppResponse(
  cacheName: string,
  load: () => Promise<unknown>,
  keySuffix?: string,
): Promise<Response> {
  const suffix = keySuffix === undefined ? "" : `/${encodeURIComponent(keySuffix)}`;
  const key = new URL(`/app/${encodeURIComponent(cacheName)}${suffix}`, APP_CACHE_ORIGIN);
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
