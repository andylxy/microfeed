import {describe, expect, it} from "vitest";

import {
  APP_BOOK_FANG_CACHE,
  APP_CHAPTER_CONTENT_CACHE,
  APP_STYLE_CONFIG_CACHE,
  APP_YAO_ALIASES_CACHE,
  APP_ZHONGYAO_CACHE,
  bookFangKeySuffix,
  cachedAppResponse,
  chapterContentKeySuffix,
  purgeAppBookFangCache,
  purgeAppChapterContentCache,
  purgeAppStyleConfigCache,
  purgeAppYaoCache,
} from "@/server/cache/app-cache";
import {APP_CACHE_TAG} from "@/server/cache/cache-control";

/**
 * App 章节正文 / 方剂缓存桶（ADR-0048 D2）的键形、命中回源与清桶。
 * Worker 测试池内 `caches.default` 可用；每个用例用独立 id，避免跨用例键污染。
 */
describe("app chapter-content / book-fang cache buckets", () => {
  it("keys carry the id and the member/public tier", () => {
    expect(chapterContentKeySuffix("chap0000001", "member"))
      .toBe("chap0000001:member");
    expect(chapterContentKeySuffix("chap0000001", "public"))
      .toBe("chap0000001:public");
    expect(bookFangKeySuffix("book0000001", "member"))
      .toBe("book0000001:member");
    // 白名单外的 id 不构造键（端点回 400）。
    expect(chapterContentKeySuffix("a/b", "public")).toBeNull();
    expect(chapterContentKeySuffix("a:b", "public")).toBeNull();
    expect(chapterContentKeySuffix("", "public")).toBeNull();
    expect(bookFangKeySuffix("x".repeat(65), "member")).toBeNull();
  });

  it("serves the second call from the cache without re-loading", async () => {
    let loads = 0;
    const load = async () => {
      loads += 1;
      return [{section: 1, text: "素问条文"}];
    };
    const first = await cachedAppResponse(
      APP_CHAPTER_CONTENT_CACHE,
      load,
      "chcache0001:public",
    );
    await expect(first.clone().json()).resolves.toEqual({
      code: 200,
      data: [{section: 1, text: "素问条文"}],
      msg: "请求成功",
    });
    expect(first.headers.get("cache-control")).toBe("public, max-age=86400");

    const second = await cachedAppResponse(
      APP_CHAPTER_CONTENT_CACHE,
      load,
      "chcache0001:public",
    );
    await expect(second.clone().json()).resolves.toEqual({
      code: 200,
      data: [{section: 1, text: "素问条文"}],
      msg: "请求成功",
    });
    expect(loads).toBe(1);

    // tier 是键的一部分：另一档是独立条目，回源一次。
    await cachedAppResponse(
      APP_CHAPTER_CONTENT_CACHE,
      load,
      "chcache0001:member",
    );
    expect(loads).toBe(2);
  });

  it("purging a chapter drops both tier buckets", async () => {
    let loads = 0;
    const load = async () => {
      loads += 1;
      return [];
    };
    for (const tier of ["member", "public"] as const) {
      await cachedAppResponse(
        APP_CHAPTER_CONTENT_CACHE,
        load,
        `chcache0002:${tier}`,
      );
    }
    expect(loads).toBe(2);

    await purgeAppChapterContentCache("chcache0002");
    await cachedAppResponse(
      APP_CHAPTER_CONTENT_CACHE,
      load,
      "chcache0002:member",
    );
    expect(loads).toBe(3);
  });

  it("purging a book drops its fang buckets", async () => {
    let loads = 0;
    const load = async () => {
      loads += 1;
      return [];
    };
    await cachedAppResponse(APP_BOOK_FANG_CACHE, load, "bkfang0001:public");
    expect(loads).toBe(1);

    await purgeAppBookFangCache("bkfang0001");
    await cachedAppResponse(APP_BOOK_FANG_CACHE, load, "bkfang0001:public");
    expect(loads).toBe(2);
  });

  it("purging yao buckets drops both zhongyao and aliases (ADR-0049 D2)", async () => {
    let zhongyaoLoads = 0;
    let aliasLoads = 0;
    await cachedAppResponse(APP_ZHONGYAO_CACHE, async () => {
      zhongyaoLoads += 1;
      return [];
    });
    await cachedAppResponse(APP_YAO_ALIASES_CACHE, async () => {
      aliasLoads += 1;
      return [];
    });
    expect(zhongyaoLoads).toBe(1);
    expect(aliasLoads).toBe(1);

    // 一条中药写入清两键：目录与派生别名同时失效。
    await purgeAppYaoCache();
    await cachedAppResponse(APP_ZHONGYAO_CACHE, async () => {
      zhongyaoLoads += 1;
      return [];
    });
    await cachedAppResponse(APP_YAO_ALIASES_CACHE, async () => {
      aliasLoads += 1;
      return [];
    });
    expect(zhongyaoLoads).toBe(2);
    expect(aliasLoads).toBe(2);

    // 退役后只剩中药写入这一条清理入口；重复调用仍清两键。
    await purgeAppYaoCache();
    await cachedAppResponse(APP_YAO_ALIASES_CACHE, async () => {
      aliasLoads += 1;
      return [];
    });
    expect(aliasLoads).toBe(3);
    await cachedAppResponse(APP_ZHONGYAO_CACHE, async () => {
      zhongyaoLoads += 1;
      return [];
    });
    expect(zhongyaoLoads).toBe(3);
  });

  it("caches the style config, tags it with its bucket, and purges one key", async () => {
    let loads = 0;
    const load = async () => {
      loads += 1;
      return {version: loads, tips: []};
    };
    const first = await cachedAppResponse(APP_STYLE_CONFIG_CACHE, load);
    await expect(first.clone().json()).resolves.toEqual({
      code: 200,
      data: {version: 1, tips: []},
      msg: "请求成功",
    });
    // style 桶属 config 档，默认 86400 秒。
    expect(first.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(first.headers.get("cache-tag")).toBe(
      `${APP_CACHE_TAG}, ${APP_CACHE_TAG}:style`,
    );

    await cachedAppResponse(APP_STYLE_CONFIG_CACHE, load);
    expect(loads).toBe(1);

    await purgeAppStyleConfigCache();
    await cachedAppResponse(APP_STYLE_CONFIG_CACHE, load);
    expect(loads).toBe(2);
  });
});
