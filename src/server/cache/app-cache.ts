import {appEnvelope} from "@/server/tcm/envelope";
import {jsonResponse} from "@/server/http";
import type {AppNavTier} from "@/server/tcm/reads";

/**
 * App 公共数据端点的服务端缓存。
 *
 * 这些端点（GetAllZhongYao / GetAliaZhongYao / GetNav / GetBookChapter）返回全库
 * 公共数据，内容不随调用者身份变化（GetNav 与 GetBookChapter 按「是否会员」分两个
 * 内容桶，仍不区分具体是谁），但调用方都带 Bearer 凭证，
 * `applyWorkerCachePolicy` 因此把它们强制成 `private, no-store`——
 * 源码里写的 `public, max-age=300` 从未生效，每次请求都打 D1。
 *
 * 这里用 Worker 内的 Cache API 自管缓存：key 是固定的内部 URL（不含用户身份，
 * 同一档位的用户共享同一份）。命中直接回包，未命中才走 D1 并回填。
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
 * 频率远低于读频率，与公开书页的边缘缓存 TTL 保持一致。书变更会显式清缓存
 * （`purgeAppBookCache`），所以「编辑后陈旧整个 TTL」不适用于目录与章节表。
 */
const APP_CACHE_TTL = 86400;
const APP_CACHE_ORIGIN = "https://app-cache.microfeed.internal";

/** 目录端点的缓存名；写缓存与清缓存共用这一个值。 */
export const APP_NAV_CACHE = "nav-v3";
/** 目录的两只内容桶：会员与公开。 */
export const APP_NAV_TIERS = ["member", "public"] as const;
/** 一本书的章节目录缓存名（键后缀是 `<bookId>:<tier>`）。 */
export const APP_BOOK_CHAPTERS_CACHE = "book-chapters";

/**
 * bookId 白名单：字母、数字、下划线、连字符，1-64 位。本机快照的 channel id
 * 是 11 位字母数字（导入id 同形），放到 64 位留足余量。
 *
 * bookId 是查询参数，先进白名单再进缓存键：`/` `\` `?` `#` `:` 这类字符会被
 * URL 归一化改写键的写法（`a/../b` 与 `b` 同键、`#` 之后整段掉出路径），
 * 放行即允许用一个键换掉另一本书的缓存条目。真实 id 用不到这些字符。
 */
const APP_BOOK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Workers 运行时 Cache Storage 的最小接口（`caches.default`，按 URL 存取）。 */
interface WorkerCache {
  delete(key: URL): Promise<boolean>;
  match(request: URL | Request): Promise<Response | undefined>;
  put(request: URL | Request, response: Response): Promise<void>;
}

function appCacheOrNull(): WorkerCache | null {
  const storage = (globalThis as {caches?: {default?: WorkerCache}}).caches;
  return storage?.default ?? null;
}

function appCache(): WorkerCache {
  const storage = appCacheOrNull();
  if (!storage) {
    throw new Error("Cache Storage unavailable in this runtime");
  }
  return storage;
}

/**
 * 缓存键：`/app/<cacheName>[/<keySuffix>]`。写缓存与清缓存共用这一处拼法，
 * 两边不会因为各拼一遍而清错键。
 *
 * 后缀不进百分号编码：它由内部生成（档位 `member` / `public`，或经白名单的
 * `<bookId>:<tier>`），冒号是分隔符——编码成 `%3A` 会让键既不好读，也没法跟
 * 测试里按字面量拼出的键保持一致。外部输入只有 bookId 一处，进后缀前先过
 * {@link bookChaptersKeySuffix} 的白名单，URL 归一化没有可乘之机。
 */
function appCacheKey(cacheName: string, keySuffix?: string): URL {
  const suffix = keySuffix === undefined ? "" : `/${keySuffix}`;
  return new URL(`/app/${encodeURIComponent(cacheName)}${suffix}`, APP_CACHE_ORIGIN);
}

/**
 * 章节目录缓存键的后缀 `<bookId>:<tier>`：写（GetBookChapter）与清
 * （purgeAppBookCache）共用这一处拼法，两边不会各拼一遍而清错键。
 *
 * bookId 先过 {@link APP_BOOK_ID_PATTERN} 白名单：非法值返回 null，端点回
 * 400，键不会被构造出来。
 */
export function bookChaptersKeySuffix(
  bookId: string,
  tier: AppNavTier,
): string | null {
  return APP_BOOK_ID_PATTERN.test(bookId) ? `${bookId}:${tier}` : null;
}

/**
 * `keySuffix` 给「同一逻辑端点、多份不同内容」用：`caches.default` 的键是完整
 * URL，把 bookId 之类拼进路径就能按参数分份共享键，而仍然不含调用者身份
 * （不同用户命中同一份，与身份无关才安全；身份相关的端点禁止进来）。
 * 现有端点里 GetNav 按会员档分两份，GetBookChapter 按 `<bookId>:<tier>` 分份。
 */
export async function cachedAppResponse(
  cacheName: string,
  load: () => Promise<unknown>,
  keySuffix?: string,
): Promise<Response> {
  const key = appCacheKey(cacheName, keySuffix);
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

/**
 * 清掉一本书相关的 App 缓存：目录两桶 + 该书章节表两桶。
 *
 * 书状态从「显示」改成「会员」时，公开桶里旧的那份必须立刻消失——否则非会员
 * 最多还能看 24h。书的标题 / 作者也在目录里，所以任何书变更都清。
 * 本地 dev 或受限运行时没有 Cache Storage，静默跳过。
 */
export async function purgeAppBookCache(bookId: string): Promise<void> {
  const storage = appCacheOrNull();
  if (!storage) return;
  const keys = [
    ...APP_NAV_TIERS.map((tier) => appCacheKey(APP_NAV_CACHE, tier)),
  ];
  for (const tier of APP_NAV_TIERS) {
    const suffix = bookChaptersKeySuffix(bookId, tier);
    if (suffix !== null) keys.push(appCacheKey(APP_BOOK_CHAPTERS_CACHE, suffix));
  }
  for (const key of keys) {
    try {
      await storage.delete(key);
    } catch {
      // 删不掉不影响正确性：下一次未命中会重写。
    }
  }
}
