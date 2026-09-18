import {afterEach, describe, expect, it, vi} from "vitest";

import FeedPublicJsonBuilder from "@/server/feed/FeedPublicJsonBuilder";
import FeedPublicRssBuilder from "@/server/feed/FeedPublicRssBuilder";
import {LEGACY_DEFAULT_FAVICON_URL} from "@/shared/Favicon";
import {STATUSES} from "@/shared/Constants";

function buildChannel(faviconUrl: string) {
  const builder = new FeedPublicJsonBuilder(
    {
      channel: {
        image: "channel/image.png",
        title: "Example feed",
      },
      settings: {
        webGlobalSettings: {
          favicon: {
            contentType: "image/png",
            url: faviconUrl,
          },
          publicBucketUrl: "/media/",
        },
      },
    },
    "https://feed.example.com",
    new Request("https://feed.example.com/json/"),
  );

  return builder._buildPublicContentChannel();
}

describe("public JSON feed favicon", () => {
  it("falls back to the channel image before a favicon is uploaded", () => {
    expect(buildChannel(LEGACY_DEFAULT_FAVICON_URL)).toMatchObject({
      favicon: "/media/channel/image.png",
      icon: "/media/channel/image.png",
    });
  });

  it("uses a separately uploaded favicon", () => {
    expect(buildChannel("uploads/favicon.png")).toMatchObject({
      favicon: "/media/uploads/favicon.png",
      icon: "/media/channel/image.png",
    });
  });
});

describe("novel-cms extension pockets", () => {
  it("keeps channel and item _microfeed fields in the public theme context", () => {
    const json = new FeedPublicJsonBuilder(
      {
        channel: {
          _microfeed: {
            genre: "cat_x1",
            serialStatus: "serializing",
            signStatus: "signed",
            tags: ["热血", "剑道"],
          },
          title: "星河剑歌",
        },
        items: [{
          _microfeed: {
            chapterNo: 2,
            order: 2,
            reviewStatus: "approved",
            volume: "第一卷 初入江湖",
            wordCount: 2980,
          },
          description: "<p>正文</p>",
          id: "novel-item-1",
          pubDateMs: Date.parse("2026-01-11T09:00:00.000Z"),
          status: STATUSES.PUBLISHED,
          title: "第二章 断剑之秘",
        }],
        settings: {},
      },
      "https://feed.example.com",
      new Request("https://feed.example.com/json/"),
    ).getJsonData() as any;

    expect(json._microfeed).toMatchObject({
      genre: "cat_x1",
      serialStatus: "serializing",
      signStatus: "signed",
      tags: ["热血", "剑道"],
    });
    expect(json.items[0]._microfeed).toMatchObject({
      chapterNo: 2,
      order: 2,
      reviewStatus: "approved",
      volume: "第一卷 初入江湖",
      wordCount: 2980,
    });
  });

  it("does not allow custom keys to override builder-owned item metadata", () => {
    const json = new FeedPublicJsonBuilder(
      {
        channel: {title: "Example feed"},
        items: [{
          _microfeed: {status: "tampered", web_url: "https://evil.example"},
          id: "novel-item-2",
          pubDateMs: Date.parse("2026-01-11T09:00:00.000Z"),
          status: STATUSES.PUBLISHED,
          title: "Published item",
        }],
        settings: {},
      },
      "https://feed.example.com",
      new Request("https://feed.example.com/json/"),
    ).getJsonData() as any;

    expect(json.items[0]._microfeed.status).toBe("published");
    expect(json.items[0]._microfeed.web_url).toBe(
      "https://feed.example.com/i/published-item-novel-item-2/",
    );
  });
});

describe("public JSON item plain text", () => {
  it("uses only normalized stored text without a runtime HTML fallback", () => {
    const json = new FeedPublicJsonBuilder(
      {
        channel: {title: "Example feed"},
        items: [{
          contentText: "Stored text",
          description: "<p>HTML text</p>",
          id: "stored-item",
          pubDateMs: Date.parse("2026-08-01T00:00:00.000Z"),
          status: STATUSES.PUBLISHED,
          title: "Stored item",
        }, {
          description: "<p>Must not be stripped while rendering</p>",
          id: "unmigrated-item",
          pubDateMs: Date.parse("2026-08-01T00:00:00.000Z"),
          status: STATUSES.PUBLISHED,
          title: "Unmigrated item",
        }],
        settings: {},
      },
      "https://feed.example.com",
      new Request("https://feed.example.com/json/"),
    ).getJsonData() as any;
    expect(json.items[0].content_text).toBe("Stored text");
    expect(json.items[1].content_text).toBe("");
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("public channel copyright", () => {
  it("resolves current_year in JSON and RSS output", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-01-01T00:00:00.000Z"));

    const json = new FeedPublicJsonBuilder(
      {
        channel: {
          copyright: "© {{ current_year }} Example Publisher",
          title: "Example feed",
        },
        items: [],
        settings: {},
      },
      "https://feed.example.com",
      new Request("https://feed.example.com/json/"),
    ).getJsonData() as any;

    expect(json._microfeed.copyright).toBe("© 2027 Example Publisher");
    const rss = new FeedPublicRssBuilder(
      json,
      "https://feed.example.com",
    ).getRssData();
    expect(rss).toContain(
      "<copyright>© 2027 Example Publisher</copyright>",
    );

    const directRss = new FeedPublicRssBuilder({
      _microfeed: {copyright: "©{{ current_year }}"},
      items: [],
      title: "Example feed",
    }, "https://feed.example.com").getRssData();
    expect(directRss).toContain("<copyright>©2027</copyright>");
  });

  it("keeps static and unsupported copyright expressions unchanged", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-01-01T00:00:00.000Z"));

    const copyright = "© 2024 / {{unknown}} / {{_microfeed.base_url}}";
    const json = new FeedPublicJsonBuilder(
      {
        channel: {copyright, title: "Example feed"},
        items: [],
        settings: {},
      },
      "https://feed.example.com",
      new Request("https://feed.example.com/json/"),
    ).getJsonData() as any;

    expect(json._microfeed.copyright).toBe(copyright);
  });
});
