/**
 * App 公共数据端点的服务端缓存。
 *
 * 这些端点（GetAllZhongYao / GetAliaZhongYao / GetNav / GetBookChapter …）返回全库
 * 公共数据，内容不随调用者身份变化（GetNav 与 GetBookChapter 按「是否会员」分两个
 * 内容桶，仍不区分具体是谁），但调用方都带 Bearer 凭证，
 * `applyWorkerCachePolicy` 因此把它们强制成 `private, no-store`——
 * 源码里写的 `public, max-age=…` 从未生效，每次请求都打 D1。
 *
 * 这里用 Worker 内的 Cache API 自管缓存：key 是固定的内部 URL（不含用户身份，
 * 同一档位的用户共享同一份）。命中直接回包，未命中才走 D1 并回填。
 * 鉴权仍由端点之前的逻辑负责，缓存只省数据库读取。
 *
 * `GetAllMingCi` 不走这里：它的返回随调用者权限变化（有码全量、无码空数组），
 * 共享缓存会把有码用户的数据吐给无码用户。
 *
 * 缓存名 → 桶 → TTL 档的映射在 `cache-control.ts`；TTL 与开关由那张表给出。
 * 控制项整行缺失时 `parseAppCacheControl` 已把四档填成默认值，这里不再另设兜底。
 *
 * 未命中次数的算式（`ADR-0016`）：`caches.default` 的内容不跨数据中心复制，
 * 且 `cache.put` / `match` 不支持 `stale-while-revalidate`，所以一个键的每日
 * 未命中次数 = `min(当日请求数 R, 86400/TTL × POP 数 P)`。TTL 拉到 24 小时后
 * 每键每天只未命中 `P` 次，已到下限，再延长买不到东西。
 *
 * 陈旧上界是已接受的取舍：这些端点返回的是已出版典籍的静态目录，人工编辑频率远
 * 低于读频率。写路径会显式清缓存（`purgeApp*Cache`），跨机房的陈旧窗口由 TTL
 * 兜底。
 */

import {appEnvelope} from "@/server/tcm/envelope";
import type {AppNavTier} from "@/server/tcm/reads";
import {TTL_TIER_OF, type AppCacheBucket} from "@/shared/AppCacheControl";
import {
  APP_CACHE_TAG,
  BUCKET_OF_CACHE,
  readAppCacheControl,
} from "./cache-control";
import {
  deleteWorkerCacheKeys,
  readJsonEntry,
  workerCacheKey,
  workerCacheOrNull,
  writeJsonEntry,
} from "./worker-cache";

/** App 端点的响应头：JSON 与缓存策略分开取，命中与回源两条路都带同一份。 */
const JSON_CONTENT_TYPE = "application/json;charset=UTF-8";
const APP_CACHE_ORIGIN = "https://app-cache.microfeed.internal";

/** 目录端点的缓存名；写缓存与清缓存共用这一个值。 */
export const APP_NAV_CACHE = "nav-v3";
/** 目录的两只内容桶：会员与公开。 */
export const APP_NAV_TIERS = ["member", "public"] as const;
/** 一本书的章节目录缓存名（键后缀是 `<bookId>:<tier>`）。 */
export const APP_BOOK_CHAPTERS_CACHE = "book-chapters";
/** 章节正文缓存名（ADR-0048 D2；键后缀是 `<chapterId>:<tier>`）。 */
export const APP_CHAPTER_CONTENT_CACHE = "chapter-content-v1";
/** 一本书的方剂缓存名（ADR-0048 D2；键后缀是 `<bookId>:<tier>`）。 */
export const APP_BOOK_FANG_CACHE = "book-fang-v1";
/** 全库中药目录缓存名（GetAllZhongYao；无 tier 分桶，内容不随身份变化）。 */
export const APP_ZHONGYAO_CACHE = "zhongyao";
/** 全库别名缓存名（GetAliaZhongYao；含派生别名，随中药 bieMing 与手工别名变化）。 */
export const APP_YAO_ALIASES_CACHE = "yao-aliases";
/** 标记样式目录缓存名（GetTipsStyleConfig；`version` 字段供 App 判新旧）。 */
export const APP_STYLE_CONFIG_CACHE = "style-config";
/** 登录方式配置缓存名（ADR-0050 D3；写缓存与保存清理共用这一个值）。 */
export const APP_LOGIN_METHODS_CACHE = "login-methods";

/**
 * 缓存键 id 白名单：字母、数字、下划线、连字符，1-64 位。本机快照的 channel /
 * item id 都是 11 位字母数字（导入 id 同形），放到 64 位留足余量。
 *
 * bookId / chapterId 都是查询参数，先进白名单再进缓存键：`/` `\` `?` `#` `:`
 * 这类字符会被 URL 归一化改写键的写法（`a/../b` 与 `b` 同键、`#` 之后整段掉出
 * 路径），放行即允许用一个键换掉另一本书/另一章的缓存条目。真实 id 用不到
 * 这些字符。
 */
const APP_CACHE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

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
  return workerCacheKey(
    APP_CACHE_ORIGIN,
    `/app/${encodeURIComponent(cacheName)}${suffix}`,
  );
}

/** 键后缀的统一拼法 `<id>:<tier>`：id 先过白名单，非法值返回 null。 */
function idTierKeySuffix(id: string, tier: AppNavTier): string | null {
  return APP_CACHE_ID_PATTERN.test(id) ? `${id}:${tier}` : null;
}

/**
 * 章节目录缓存键的后缀 `<bookId>:<tier>`：写（GetBookChapter）与清
 * （purgeAppBookCache）共用这一处拼法，两边不会各拼一遍而清错键。
 */
export function bookChaptersKeySuffix(
  bookId: string,
  tier: AppNavTier,
): string | null {
  return idTierKeySuffix(bookId, tier);
}

/** 章节正文缓存键的后缀 `<chapterId>:<tier>`（ADR-0048 D2）。 */
export function chapterContentKeySuffix(
  chapterId: string,
  tier: AppNavTier,
): string | null {
  return idTierKeySuffix(chapterId, tier);
}

/** 方剂缓存键的后缀 `<bookId>:<tier>`（ADR-0048 D2）。 */
export function bookFangKeySuffix(
  bookId: string,
  tier: AppNavTier,
): string | null {
  return idTierKeySuffix(bookId, tier);
}

/** 一个桶写入响应时要带的两条标签：总标签与分桶标签。 */
function cacheTagHeader(bucket: AppCacheBucket): string {
  return `${APP_CACHE_TAG}, ${APP_CACHE_TAG}:${bucket}`;
}

/**
 * `keySuffix` 给「同一逻辑端点、多份不同内容」用：`caches.default` 的键是完整
 * URL，把 bookId 之类拼进路径就能按参数分份共享键，而仍然不含调用者身份
 * （不同用户命中同一份，与身份无关才安全；身份相关的端点禁止进来）。
 *
 * 控制项（方案第 5 节）决定四件事：总开关与按桶开关决定要不要读写缓存，TTL 档
 * 决定 `max-age`，`maxEntryBytes` 决定这条响应要不要写。体积判定用
 * `body.length * 3` 作 UTF-8 字节数的上界——真实编码一次要几毫秒，免费档每次
 * 调用只有 10 ms CPU，大响应（zhongyao 约 2 MB）经不起。
 */
export async function cachedAppResponse(
  cacheName: string,
  load: () => Promise<unknown>,
  keySuffix?: string,
): Promise<Response> {
  const bucket = BUCKET_OF_CACHE[cacheName];
  if (bucket === undefined) {
    throw new Error(`app-cache: 缓存名未登记到控制项：${cacheName}`);
  }
  const control = await readAppCacheControl();
  const ttl = control.ttls[TTL_TIER_OF[bucket]];
  const storage = workerCacheOrNull();
  const bypass = !control.enabled || !control.buckets[bucket] || storage === null;
  const key = appCacheKey(cacheName, keySuffix);

  if (!bypass) {
    let hit: Response | undefined;
    try {
      hit = await storage.match(key);
    } catch {
      hit = undefined;
    }
    if (hit) return hit;
  }

  // 单份 JSON 字符串构造两个 Response（ADR-0049 D13④）：`response.clone()`
  // 会 tee 出双份流缓冲（zhongyao 目录 ≈2MB 时峰值翻倍）；字符串复用没有
  // 这个代价。
  const body = JSON.stringify(appEnvelope(await load()));
  if (bypass) {
    return new Response(body, {headers: {
      "cache-control": "no-store",
      "content-type": JSON_CONTENT_TYPE,
    }});
  }
  if (body.length * 3 > control.maxEntryBytes) {
    return new Response(body, {headers: {
      "cache-control": "no-store",
      "content-type": JSON_CONTENT_TYPE,
    }});
  }
  const headers = {
    "cache-control": `public, max-age=${ttl}`,
    "cache-tag": cacheTagHeader(bucket),
    "content-type": JSON_CONTENT_TYPE,
  };
  const response = new Response(body, {headers});
  try {
    await storage.put(key, new Response(body, {headers}));
  } catch {
    // 缓存写入失败（本地 dev / 权限受限）不阻塞响应，退化为直连 D1。
  }
  return response;
}

/** 目录两只桶的缓存键（会员 / 公开）。 */
function navCacheKeys(): URL[] {
  return APP_NAV_TIERS.map((tier) => appCacheKey(APP_NAV_CACHE, tier));
}

/**
 * 通用 JSON read-through：命中返回缓存值；未命中或缓存条目不是合法 JSON 时
 * `load()` 回源、把返回值 stringify 写回缓存（写失败静默退化为直读，下一次
 * 未命中重写）。与 {@link cachedAppResponse} 的差异：对象进出，调用方自己
 * 决定呈现形状。缓存条目可能由旧版本代码写入，返回值一律按未校验的
 * `unknown` 交给调用方归一。
 *
 * TTL 与开关都取自控制项：总开关或该桶关闭时直连回源，TTL 取该桶的档，
 * 写入的条目带 `Cache-Tag` 供跨机房清空。控制项自己读写时不走这里，
 * 否则读控制项要先读控制项。
 */
export async function cachedJson<T>(
  cacheName: string,
  load: () => Promise<T>,
  bucket: AppCacheBucket,
): Promise<T> {
  const key = appCacheKey(cacheName);
  const storage = workerCacheOrNull();
  const control = await readAppCacheControl();
  const bypass = storage === null ||
    !control.enabled ||
    !control.buckets[bucket];
  if (!bypass) {
    const hit = await readJsonEntry<T>(key);
    if (hit !== null) return hit;
  }
  const value = await load();
  if (!bypass) {
    const ttl = control.ttls[TTL_TIER_OF[bucket]];
    await writeJsonEntry(
      key,
      value,
      ttl,
      [APP_CACHE_TAG, `${APP_CACHE_TAG}:${bucket}`],
    );
  }
  return value;
}

/**
 * 清掉一个 {@link cachedJson} 条目（写路径保存后调用）。删除是各 POP 本地
 * 操作（ADR-0049 D13⑤）：处理保存的机房下次请求即回源新值，其余机房等
 * TTL 自然过期。需要跨机房立刻生效时改用 `cache.purge({tags})`。
 */
export async function deleteCachedJson(cacheName: string): Promise<void> {
  await deleteWorkerCacheKeys([appCacheKey(cacheName)]);
}

/**
 * 清掉 App 目录的两只桶（会员 / 公开）。
 *
 * 分类的任何变更都会改目录的收录与排序（GetNav 按 `ch.genre = c.id` 聚合、按
 * `c.sort` 排序；删分类会把该分类下全部书的 genre 置空，书从目录消失）——书数据
 * 没变，所以由分类写路径清这两只桶，不动书章节表。
 */
export async function purgeAppNavCache(): Promise<void> {
  await deleteWorkerCacheKeys(navCacheKeys());
}

/**
 * 清掉一本书相关的 App 缓存：目录两桶 + 该书章节表两桶。
 *
 * 书状态从「显示」改成「会员」时，公开桶里旧的那份必须立刻消失——否则非会员
 * 最多还能看 24h。书的标题 / 作者也在目录里，所以任何书变更都清。
 *
 * 调用点收在 `extBook.ts` 的四个写函数（建 / 改 / 软删 / 物理删）：`channels`
 * 的收录与状态写都经它们，清桶跟着写函数走，端点无须各自记忆（`FeedDb` 删封面图
 * 也写 channels，但只动 `$.image`、不影响目录收录）。分类写路径
 * （`extCategory.ts` 的改 / 删 / 排序）清的是 {@link purgeAppNavCache} 两只
 * 目录桶——书数据没变，不碰章节表。
 */
export async function purgeAppBookCache(bookId: string): Promise<void> {
  const keys = navCacheKeys();
  for (const tier of APP_NAV_TIERS) {
    const suffix = bookChaptersKeySuffix(bookId, tier);
    if (suffix !== null) keys.push(appCacheKey(APP_BOOK_CHAPTERS_CACHE, suffix));
  }
  await deleteWorkerCacheKeys(keys);
}

/**
 * 清掉一章正文的两只桶（ADR-0048 D2）。条目写路径按 tcm_kind 分派到这里：
 * `chapter` 直接传章 id；`section` 传其 `tcm_parent_id`（所属章）。
 */
export async function purgeAppChapterContentCache(
  chapterId: string,
): Promise<void> {
  const keys: URL[] = [];
  for (const tier of APP_NAV_TIERS) {
    const suffix = chapterContentKeySuffix(chapterId, tier);
    if (suffix !== null) {
      keys.push(appCacheKey(APP_CHAPTER_CONTENT_CACHE, suffix));
    }
  }
  await deleteWorkerCacheKeys(keys);
}

/** 清掉一本书方剂表的两只桶（ADR-0048 D2）。 */
export async function purgeAppBookFangCache(bookId: string): Promise<void> {
  const keys: URL[] = [];
  for (const tier of APP_NAV_TIERS) {
    const suffix = bookFangKeySuffix(bookId, tier);
    if (suffix !== null) keys.push(appCacheKey(APP_BOOK_FANG_CACHE, suffix));
  }
  await deleteWorkerCacheKeys(keys);
}

/**
 * 清掉全库中药目录与别名两桶（ADR-0049 D2）：中药行携带 bieMing，一条中药
 * 写入同时使 GetAllZhongYao（含经疏正文）与 GetAliaZhongYao（派生别名）陈旧，
 * 所以 yao 写与经疏 section 写清两键。
 */
export async function purgeAppYaoCache(): Promise<void> {
  await deleteWorkerCacheKeys([
    appCacheKey(APP_ZHONGYAO_CACHE),
    appCacheKey(APP_YAO_ALIASES_CACHE),
  ]);
}

/** 清掉标记样式目录桶（后台增删改一个标记就清，`version` 随之变化）。 */
export async function purgeAppStyleConfigCache(): Promise<void> {
  await deleteWorkerCacheKeys([appCacheKey(APP_STYLE_CONFIG_CACHE)]);
}
