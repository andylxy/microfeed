import {describe, expect, it} from "vitest";

import {
  APP_BOOK_FANG_CACHE,
  APP_CHAPTER_CONTENT_CACHE,
  bookFangKeySuffix,
  cachedAppResponse,
  chapterContentKeySuffix,
  purgeAppBookFangCache,
  purgeAppChapterContentCache,
} from "@/server/cache/app-cache";

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
});
