/**
 * App 公共数据端点的服务端缓存验证（src/server/cache/app-cache.ts）。
 *
 * 锁定行为：四个公共端点（GetAllZhongYao / GetAliaZhongYao / GetNav /
 * GetBookChapter）首次请求把响应写入 Cache API，后续请求即使 D1 不可用也能返回
 * 同一响应体，即命中缓存后完全不读库。这是每天 5M rows_read 额度下的关键防线：
 * 源码里的 public, max-age=300 出站头会被 applyWorkerCachePolicy 覆盖成
 * no-store，缓存必须由端点自己持有（见 app-cache.ts 头注释）。
 */
import {describe, expect, it} from "vitest";
import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import * as GetAllZhongYao from "@/pages/api/AppBookRequest/GetAllZhongYao";
import * as GetAliaZhongYao from "@/pages/api/AppBookRequest/GetAliaZhongYao";
import * as GetBookChapter from "@/pages/api/AppBookRequest/GetBookChapter";
import * as GetNav from "@/pages/api/AppBookRequest/GetNav";
import {purgeAppBookCache, purgeAppNavCache} from "@/server/cache/app-cache";

const CACHE_ORIGIN = "https://app-cache.microfeed.internal";
const ORIGIN = "https://app.example.com";

/**
 * `GetBookChapter` 按 bookId 分键，所以它需要一个库里没有的 id：未知 id 查询
 * 无行、返回空数组（不是失败），首请求照样走完整的「查库 → 写缓存」路径。
 * 这里锁定的是缓存机制本身，不是响应内容。
 */
const EMPTY_BOOK_ID = "BkAppCacheEmpty01";

/**
 * 构造 Astro APIContext：端点不读 request，但 GetNav 会读 `locals.appMember`
 * （非会员走公开桶），所以 locals 必须给一个空对象。
 */
function ctx(path: string): never {
  return {locals: {}, url: new URL(ORIGIN + path)} as never;
}

/** Workers 运行时 Cache Storage 的最小接口（`caches.default`，按 URL 存取）。 */
interface WorkerCache {
  match(request: URL): Promise<Response | undefined>;
}

function peekCache(): WorkerCache {
  const storage = (globalThis as {caches?: {default?: WorkerCache}}).caches;
  if (!storage?.default) throw new Error("Cache Storage unavailable");
  return storage.default;
}

/**
 * `cacheKey` 是 `CACHE_ORIGIN` 之下的完整路径——`caches.default` 的键就是整个
 * URL，所以带分键的端点要传 `"/app/book-chapters/<bookId>:<tier>"` 这样的完整路径，不能只传裸名字。
 */
async function expectCachedAfterFirst(
  path: string,
  get: APIRoute,
  cacheKey: string,
): Promise<void> {
  const first = await get(ctx(path));
  expect(first.status).toBe(200);
  const body = await first.text();
  const cached = await peekCache().match(new URL(cacheKey, CACHE_ORIGIN));
  expect(cached).toBeDefined();
  const original = env.FEED_DB;
  (env as {FEED_DB: unknown}).FEED_DB = new Proxy({}, {
    get() { throw new Error("should not touch D1"); },
  });
  try {
    const second = await get(ctx(path));
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(body);
  } finally {
    (env as {FEED_DB: unknown}).FEED_DB = original;
  }
}

describe("App 公共端点服务端缓存", () => {
  it("GetAllZhongYao：首请求写入缓存，之后断开 D1 仍能返回同一响应体", async () => {
    await expectCachedAfterFirst(
      "/api/AppBookRequest/GetAllZhongYao", GetAllZhongYao.GET, "/app/zhongyao",
    );
  });

  it("GetAliaZhongYao：同上", async () => {
    await expectCachedAfterFirst(
      "/api/AppBookRequest/GetAliaZhongYao", GetAliaZhongYao.GET, "/app/yao-aliases",
    );
  });

  it("GetNav：非会员走公开桶（/app/nav-v3/public）", async () => {
    await expectCachedAfterFirst(
      "/api/AppBookRequest/GetNav", GetNav.GET, "/app/nav-v3/public",
    );
  });

  it("GetNav：会员走另一只桶（/app/nav-v3/member）", async () => {
    const response = await GetNav.GET({
      locals: {appMember: true},
      url: new URL(`${ORIGIN}/api/AppBookRequest/GetNav`),
    } as never);
    expect(response.status).toBe(200);
    expect(
      await peekCache().match(new URL("/app/nav-v3/member", CACHE_ORIGIN)),
    ).toBeDefined();
  });

  it("GetBookChapter：按 bookId 与会员档分键，缓存后不再读库", async () => {
    await expectCachedAfterFirst(
      `/api/AppBookRequest/GetBookChapter?bookId=${EMPTY_BOOK_ID}`,
      GetBookChapter.GET,
      `/app/book-chapters/${EMPTY_BOOK_ID}:public`,
    );
  });

  it("GetBookChapter：非法 bookId 一律 400，缓存键不成立", async () => {
    // bookId 进缓存键前要过白名单：`/` `\` `?` `#` `:` 会被 URL 归一化改写键的
    // 写法（`a/../b` 与 `b` 同键），放行即允许用一个键换掉另一本书的缓存条目。
    // 合法形状由上面「按 bookId 与会员档分键」一例覆盖（EMPTY_BOOK_ID 走通）。
    for (const bookId of ["a/../b", "a%2Fb", "a#b", "a?b", "a:b", "a\\b", "..", "a b"]) {
      const response = await GetBookChapter.GET(
        ctx(`/api/AppBookRequest/GetBookChapter?bookId=${encodeURIComponent(bookId)}`),
      );
      expect(response.status).toBe(400);
    }
  });

  it("GetBookChapter：读取失败（D1 抛错）不写缓存", async () => {
    const failBookId = "BkAppCacheFail01";
    const original = env.FEED_DB;
    (env as {FEED_DB: unknown}).FEED_DB = new Proxy({}, {
      get() { throw new Error("d1 down"); },
    });
    try {
      // 失败抛出而非降级空值：空值会被 cachedAppResponse 当成成功响应写进 24h 缓存。
      // 直接调用路由时抛出原样逸出（生产里由 Astro 管线转成 500 回给 App）。
      await expect(
        GetBookChapter.GET(
          ctx(`/api/AppBookRequest/GetBookChapter?bookId=${failBookId}`),
        ),
      ).rejects.toThrow("d1 down");
    } finally {
      (env as {FEED_DB: unknown}).FEED_DB = original;
    }
    expect(
      await peekCache().match(
        new URL(`/app/book-chapters/${failBookId}:public`, CACHE_ORIGIN),
      ),
    ).toBeUndefined();
  });

  const keyOf = (path: string) => new URL(path, CACHE_ORIGIN);

  /** 预热两个 purge 测试共同关心的四只桶：nav 公开 / nav 会员 / 一本书章节表公开档。 */
  async function warmPurgeBuckets(): Promise<void> {
    await GetNav.GET({
      locals: {appMember: false},
      url: new URL(`${ORIGIN}/api/AppBookRequest/GetNav`),
    } as never);
    await GetNav.GET({
      locals: {appMember: true},
      url: new URL(`${ORIGIN}/api/AppBookRequest/GetNav`),
    } as never);
    await GetBookChapter.GET({
      locals: {},
      url: new URL(`${ORIGIN}/api/AppBookRequest/GetBookChapter?bookId=${EMPTY_BOOK_ID}`),
    } as never);
  }

  it("purgeAppBookCache 清掉目录两桶与该书章节表两桶", async () => {
    await warmPurgeBuckets();

    expect(await peekCache().match(keyOf("/app/nav-v3/public"))).toBeDefined();
    expect(await peekCache().match(keyOf("/app/nav-v3/member"))).toBeDefined();
    expect(
      await peekCache().match(keyOf(`/app/book-chapters/${EMPTY_BOOK_ID}:public`)),
    ).toBeDefined();

    await purgeAppBookCache(EMPTY_BOOK_ID);

    expect(await peekCache().match(keyOf("/app/nav-v3/public"))).toBeUndefined();
    expect(await peekCache().match(keyOf("/app/nav-v3/member"))).toBeUndefined();
    expect(
      await peekCache().match(keyOf(`/app/book-chapters/${EMPTY_BOOK_ID}:public`)),
    ).toBeUndefined();
  });

  it("purgeAppNavCache 只清目录两桶，不碰书章节表（分类写路径）", async () => {
    // 分类变更（extCategory 的改/删/排序）只动目录的收录与排序，书数据不动，
    // 所以它的清缓存路径只清 nav-v3 两桶，不能顺手清掉书章节表。若误清章节表，
    // 下面这条 book-chapters 断言会失败。
    await warmPurgeBuckets();

    expect(await peekCache().match(keyOf("/app/nav-v3/public"))).toBeDefined();
    expect(await peekCache().match(keyOf("/app/nav-v3/member"))).toBeDefined();
    expect(
      await peekCache().match(keyOf(`/app/book-chapters/${EMPTY_BOOK_ID}:public`)),
    ).toBeDefined();

    await purgeAppNavCache();

    expect(await peekCache().match(keyOf("/app/nav-v3/public"))).toBeUndefined();
    expect(await peekCache().match(keyOf("/app/nav-v3/member"))).toBeUndefined();
    // 章节表两桶必须保留：分类写路径不负责清它们。
    expect(
      await peekCache().match(keyOf(`/app/book-chapters/${EMPTY_BOOK_ID}:public`)),
    ).toBeDefined();
  });
});
