import {isAdminPathname} from "@/shared/AdminPath";
import {
  ITEMS_SORT_ORDERS,
  SETTINGS_CATEGORIES,
} from "@/shared/Constants";
import {
  decodeItemCursor,
  ITEM_ORDERS,
  ITEM_SORTS,
} from "@/shared/ItemPagination";
import {getIdFromSlug} from "@/shared/StringUtils";
import type {FeedContent, ImageMetadataTarget} from "@/types";

export const PUBLIC_CACHE_BROWSER_CONTROL = "no-cache";

/**
 * 边缘 TTL 从 300 秒提到 24 小时，理由是未命中上限的算术，不是偏好：
 * Cloudflare 的 CDN 缓存按 POP 各自判定新鲜度，单个 URL 的每日回源次数
 * 上限 = `min(当日请求数 R, 86400/TTL × POP 数 P)`。TTL=300s 时 P=3 给出 864，
 * 即单 URL 每天要有 >864 次请求才开始受益——中医站每本书一个 `/book/{id}/`
 * 的访问量远够不着，等于每个请求都回源，和「没开缓存」等价。
 *
 * 实测代价（2026-10-11 快照，F1/F3/F5 之后）：一次书页回源约 6,300 行
 * （`getTcmBookChapters` 6,091 + `listCategoryNav` 46 + `listPublishedBookSamples` 42）；
 * 非 TCM 书页约 3,200 行（`getBookChapters` 2,965 + …）。免费额度 5M 行/日，
 * ⇒ 现状只买得起约 1,000 次页面请求；1h TTL 的平台期 4.68M 仍然超额；
 * 6h → 78 万；24h → 13 本书 × 6,300 = **81,900 行/日，且与流量无关**。
 *
 * 敢把 TTL 拉到 24h 的前提取决于写时清理的完整性：表单类写入
 * （书 / 分类 / 设置 / 主题）都已打 `Cache-Tag` 并 purge，剩余缺口是卷板
 * 写入——见 `purgeVolumeBoardCache`，补上之后 24h 的陈旧上界才是可接受的。
 *
 * `stale-while-revalidate=600`：回源瞬间拿旧内容先答，后台刷新，
 * 让「过期后第一击」不阻塞读者。`stale-if-error=86400` 维持不变：
 * 回源失败时 D1/Worker 抖动不该变成读者的错误页。
 */
export const PUBLIC_CACHE_EDGE_CONTROL =
  "public, max-age=86400, stale-while-revalidate=600, stale-if-error=86400";
export const PRIVATE_CACHE_CONTROL = "private, no-store";

export const PUBLIC_CACHE_TAGS = {
  CHANNEL_PRIMARY: "mf:channel:primary",
  ITEMS: "mf:items",
  PAGES: "mf:pages",
  PUBLIC: "mf:public",
  SITE_FILES: "mf:site-files",
  THEME_CURRENT: "mf:theme:current",
  item: (itemId: string) => `mf:item:${itemId}`,
  page: (pageId: string) => `mf:page:${pageId}`,
  siteFile: (siteFileId: string) => `mf:site-file:${siteFileId}`,
} as const;

export type PublicCachePurger = Pick<CacheContext, "purge">;

interface WorkerCachePolicyOptions {
  adminPath: string;
  deploymentEnvironment?: "preview" | "production";
}

const PAGINATED_PUBLIC_PATHS = new Set(["/", "/json/", "/rss/"]);
const PUBLIC_PAGE_PATHS = new Set([
  "/",
  "/.well-known/microfeed.json",
  "/json/",
  "/rss/",
  "/rss/stylesheet/",
  "/sitemap.xml",
  "/robots.txt",
  "/llms.txt",
  "/search/",
]);
const PAGINATION_PARAMETERS = new Set([
  "next_cursor",
  "order",
  "prev_cursor",
  "sort",
]);
const FEED_CONTENT_PATHS = new Set([
  "/",
  "/json/",
  "/rss/",
  "/rss/stylesheet/",
  "/sitemap.xml",
]);

function normalizedTags(tags: Iterable<string>): string[] {
  return [...new Set(tags)].filter(
    (tag) => /^[\x21-\x7e]{1,1024}$/u.test(tag) && !tag.includes(","),
  );
}

function isItemPath(pathname: string): boolean {
  return /^\/i\/[^/]+\/(?:json\/|rss\/)?$/u.test(pathname);
}

function isBookPath(pathname: string): boolean {
  return /^\/book\/[^/]+\/$/u.test(pathname);
}

/**
 * 分类页 `/category/{slug}/` 一直是漏网的：`isStandalonePagePath` 的正则只认
 * **单段**路径（`^\/[a-z0-9]+(?:-[a-z0-9]+)*\/$`），`/category/` 这一段自己倒是
 * 匹配得上，但加上 slug 变成两段就落空，于是整个分类页走的是
 * `private, no-store`——每次访问都全量回源，而它读的是 `listChannelsByGenre`
 * → `bookWordCounts`（ADR-0012 已物化，稳态只有十几次行读）。
 *
 * 这里显式补上，并把书页同款的四个标签都挂上（见 `publicCacheTagsForPath`）：
 * 它列分类内的书（`mf:channel:primary`）、带每本书的章节数（`mf:items`），
 * 并按当前主题渲染（`mf:theme:current`）。
 */
function isCategoryPath(pathname: string): boolean {
  return /^\/category\/[^/]+\/$/u.test(pathname);
}

function isStandalonePagePath(pathname: string): boolean {
  return /^\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/u.test(pathname) &&
    pathname !== "/json/" && pathname !== "/rss/" &&
    pathname !== "/search/";
}

function isSiteFilePath(pathname: string): boolean {
  return /^\/[a-z0-9][a-z0-9._-]*\.[a-z0-9]+$/u.test(pathname);
}

function isPublicPagePath(pathname: string): boolean {
  return PUBLIC_PAGE_PATHS.has(pathname) || isItemPath(pathname) ||
    isBookPath(pathname) ||
    isCategoryPath(pathname) ||
    isStandalonePagePath(pathname) || isSiteFilePath(pathname);
}

function isPublicAssetPath(pathname: string): boolean {
  return pathname.startsWith("/_astro/") ||
    pathname.startsWith("/assets/") ||
    pathname.startsWith("/media/");
}

function itemIdForPath(pathname: string): string | undefined {
  const slug = /^\/i\/([^/]+)\/(?:json\/|rss\/)?$/u.exec(pathname)?.[1];
  return slug ? getIdFromSlug(slug) : undefined;
}

function isFeedContentPath(pathname: string): boolean {
  return FEED_CONTENT_PATHS.has(pathname) || isItemPath(pathname) ||
    isStandalonePagePath(pathname) || pathname === "/search/" ||
    pathname === "/robots.txt" || pathname === "/llms.txt";
}

function isThemePath(pathname: string): boolean {
  return pathname === "/" || pathname === "/rss/stylesheet/" ||
    /^\/i\/[^/]+\/$/u.test(pathname) ||
    isStandalonePagePath(pathname) || pathname === "/search/";
}

function validPaginationQuery(url: URL): boolean {
  if (!url.search) return true;
  if (!PAGINATED_PUBLIC_PATHS.has(url.pathname)) return false;

  const entries = [...url.searchParams.entries()];
  if (
    entries.some(([key]) => !PAGINATION_PARAMETERS.has(key)) ||
    new Set(entries.map(([key]) => key)).size !== entries.length ||
    (
      url.searchParams.has("next_cursor") &&
      url.searchParams.has("prev_cursor")
    )
  ) {
    return false;
  }

  const sort = url.searchParams.get("sort");
  const canonicalSort = sort === null ||
    Object.values(ITEM_SORTS).some((value) => value === sort);
  const legacySort = Object.values(ITEMS_SORT_ORDERS).some(
    (value) => value === sort,
  );
  if (!canonicalSort && !legacySort) return false;

  const order = url.searchParams.get("order");
  if (
    order !== null &&
    !Object.values(ITEM_ORDERS).some((value) => value === order)
  ) {
    return false;
  }
  if (legacySort && order !== null) return false;

  for (const key of ["next_cursor", "prev_cursor"]) {
    const value = url.searchParams.get(key);
    if (value === null) continue;
    if (legacySort) {
      if (!/^\d{1,16}$/u.test(value)) return false;
    } else if (value.length > 512 || !decodeItemCursor(value)) {
      return false;
    }
  }
  return true;
}

function isSensitivePath(pathname: string, adminPath: string): boolean {
  return isAdminPathname(pathname, adminPath) ||
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/media" ||
    pathname.startsWith("/media/") ||
    pathname === "/media-upload" ||
    pathname.startsWith("/media-upload/") ||
    pathname === "/.well-known/microfeed/bootstrap-admin" ||
    pathname.startsWith("/.well-known/microfeed/bootstrap-admin/") ||
    pathname === "/.well-known/microfeed/theme-management" ||
    pathname.startsWith("/.well-known/microfeed/theme-management/");
}

export function publicCacheTagsForPath(pathname: string): string[] {
  const tags = new Set<string>([PUBLIC_CACHE_TAGS.PUBLIC]);
  // 书页读 channels（书名/封面）与 items（章节目录），并且按当前主题渲染，
  // 所以四个标签都要挂上——条目、频道或主题任一变更都会让书页缓存失效。
  if (isBookPath(pathname)) {
    tags.add(PUBLIC_CACHE_TAGS.ITEMS);
    tags.add(PUBLIC_CACHE_TAGS.PAGES);
    tags.add(PUBLIC_CACHE_TAGS.THEME_CURRENT);
  }
  // 分类页同理：列分类内的书（channels → CHANNEL_PRIMARY）、带每本的章节数
  // （items → ITEMS），并按当前主题渲染。四个标签与书页对齐。
  if (isCategoryPath(pathname)) {
    tags.add(PUBLIC_CACHE_TAGS.CHANNEL_PRIMARY);
    tags.add(PUBLIC_CACHE_TAGS.ITEMS);
    tags.add(PUBLIC_CACHE_TAGS.PAGES);
    tags.add(PUBLIC_CACHE_TAGS.THEME_CURRENT);
  }
  const siteFilePath = isSiteFilePath(pathname);
  if (isFeedContentPath(pathname) || siteFilePath) {
    tags.add(PUBLIC_CACHE_TAGS.CHANNEL_PRIMARY);
  }
  if (
    pathname === "/" || pathname === "/json/" || pathname === "/rss/" ||
    pathname === "/sitemap.xml" || pathname === "/llms.txt" || siteFilePath
  ) {
    tags.add(PUBLIC_CACHE_TAGS.ITEMS);
  }
  if (
    pathname === "/" || /^\/i\/[^/]+\/$/u.test(pathname) ||
    isStandalonePagePath(pathname) || pathname === "/search/" ||
    pathname === "/llms.txt" || pathname === "/sitemap.xml" || siteFilePath
  ) {
    tags.add(PUBLIC_CACHE_TAGS.PAGES);
  }
  if (siteFilePath) {
    tags.add(PUBLIC_CACHE_TAGS.SITE_FILES);
  }
  if (isThemePath(pathname)) {
    tags.add(PUBLIC_CACHE_TAGS.THEME_CURRENT);
  }
  const itemId = itemIdForPath(pathname);
  if (itemId) tags.add(PUBLIC_CACHE_TAGS.item(itemId));
  return normalizedTags(tags);
}

function isPublicCacheableResponse(
  request: Request,
  response: Response,
  options: WorkerCachePolicyOptions,
): boolean {
  const method = request.method.toUpperCase();
  const url = new URL(request.url);
  return options.deploymentEnvironment !== "preview" &&
    (method === "GET" || method === "HEAD") &&
    response.status === 200 &&
    !request.headers.has("authorization") &&
    !response.headers.has("set-cookie") &&
    isPublicPagePath(url.pathname) &&
    !isSensitivePath(url.pathname, options.adminPath) &&
    validPaginationQuery(url);
}

function responseWithCacheHeaders(
  response: Response,
  headers: Headers,
): Response {
  if (response.status === 101) return response;
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export function applyWorkerCachePolicy(
  request: Request,
  response: Response,
  options: WorkerCachePolicyOptions,
): Response {
  const headers = new Headers(response.headers);
  if (!isPublicCacheableResponse(request, response, options)) {
    headers.set("Cloudflare-CDN-Cache-Control", "no-store");
    headers.delete("Cache-Tag");
    const publicAsset = options.deploymentEnvironment !== "preview" &&
      (request.method === "GET" || request.method === "HEAD") &&
      response.status === 200 &&
      !request.headers.has("authorization") &&
      !response.headers.has("set-cookie") &&
      isPublicAssetPath(new URL(request.url).pathname);
    if (!publicAsset) {
      headers.set("Cache-Control", PRIVATE_CACHE_CONTROL);
    }
    return responseWithCacheHeaders(response, headers);
  }

  headers.set("Cache-Control", PUBLIC_CACHE_BROWSER_CONTROL);
  headers.set("Cloudflare-CDN-Cache-Control", PUBLIC_CACHE_EDGE_CONTROL);
  headers.set(
    "Cache-Tag",
    publicCacheTagsForPath(new URL(request.url).pathname).join(","),
  );
  return responseWithCacheHeaders(response, headers);
}

export function publicCacheTagsForFeedUpdate(
  feed: FeedContent,
): string[] {
  const tags = new Set<string>();
  if (feed.item) {
    tags.add(PUBLIC_CACHE_TAGS.ITEMS);
    if (typeof feed.item.id === "string") {
      tags.add(PUBLIC_CACHE_TAGS.item(feed.item.id));
    }
  }
  if (feed.channel) {
    tags.add(PUBLIC_CACHE_TAGS.CHANNEL_PRIMARY);
  }
  for (const category of Object.keys(feed.settings ?? {})) {
    if (category === SETTINGS_CATEGORIES.API_SETTINGS) {
      tags.add(PUBLIC_CACHE_TAGS.SITE_FILES);
      continue;
    }
    tags.add(
      category === SETTINGS_CATEGORIES.CUSTOM_CODE
        ? PUBLIC_CACHE_TAGS.THEME_CURRENT
        : PUBLIC_CACHE_TAGS.PUBLIC,
    );
  }
  return normalizedTags(tags);
}

export function publicCacheTagsForImageTarget(
  target: ImageMetadataTarget,
): string[] {
  if (target.type === "item") {
    return normalizedTags([
      PUBLIC_CACHE_TAGS.item(target.id),
      PUBLIC_CACHE_TAGS.ITEMS,
    ]);
  }
  if (target.type === "channel") {
    return [PUBLIC_CACHE_TAGS.CHANNEL_PRIMARY];
  }
  return [PUBLIC_CACHE_TAGS.PUBLIC];
}

export async function purgePublicCache(
  tags: Iterable<string>,
  purger: PublicCachePurger,
): Promise<void> {
  const uniqueTags = normalizedTags(tags);
  if (uniqueTags.length === 0) return;
  try {
    const result = await purger.purge({tags: uniqueTags});
    if (!result.success) {
      console.error(JSON.stringify({
        errors: result.errors,
        message: "Failed to purge public Workers cache",
        tags: uniqueTags,
      }));
    }
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      message: "Failed to purge public Workers cache",
      tags: uniqueTags,
    }));
  }
}
