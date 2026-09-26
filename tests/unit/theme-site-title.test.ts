import {readFileSync} from "node:fs";
import path from "node:path";

import Mustache from "mustache";
import {describe, expect, test} from "vitest";

import FeedPublicJsonBuilder from "@/server/feed/FeedPublicJsonBuilder";
import {themeContext} from "@/shared/themes/ThemeRenderer";

/**
 * novel-cms 自研扩展：站点标题。
 *
 * Admin 在「设置 > 站点」写入 `settings.webGlobalSettings.siteTitle`；
 * FeedPublicJsonBuilder 把它带进 `publicFeed._microfeed.siteTitle`；
 * ThemeRenderer.themeContext 再暴露成模板变量 `site_title`，缺省回退到频道标题。
 *
 * 这组测试锁住这三段链路，避免渲染器或主题模板改动时静默失效。
 * 2026-09-26：数据源从 `channel._microfeed.siteTitle` 迁到 settings，
 * 顺带锁住「旧口袋值被压制」——清空设置项不得让旧值复活。
 */

const meta = {assetBaseUrl: "/a", packageId: "p", version: "1"};

const bodyStartTemplate = () => readFileSync(
  path.resolve("themes/feed-zh/web-body-start.mustache"),
  "utf8",
);

/** 走一遍 FeedPublicJsonBuilder，拿它写进 `_microfeed` 的口袋。 */
function buildMicrofeedExtra(content: Record<string, unknown>) {
  const builder = new FeedPublicJsonBuilder(
    content,
    "https://example.com",
    {url: "https://example.com/", cf: null},
    false,
  );
  return (builder as unknown as {
    _buildPublicContentMicrofeedExtra: (p: unknown) => Record<string, unknown>;
  })._buildPublicContentMicrofeedExtra({});
}

/** 把 builder 的口袋拼回一份最小 publicFeed，交给主题上下文解析。 */
function buildPublicFeed(content: Record<string, unknown>) {
  const extra = buildMicrofeedExtra(content);
  const channel = content.channel as Record<string, unknown>;
  return {_microfeed: extra, title: channel.title};
}

describe("themeContext 的 site_title", () => {
  test("未配置时回退到频道标题", () => {
    expect(themeContext({title: "星河剑歌"}, meta).site_title).toBe("星河剑歌");
  });

  test("Admin 配置的站点标题优先", () => {
    expect(
      themeContext({title: "频道名", _microfeed: {siteTitle: "星河剑歌"}}, meta).site_title,
    ).toBe("星河剑歌");
  });

  test("空白字符串 / 非字符串一律回退", () => {
    expect(
      themeContext({title: "频道名", _microfeed: {siteTitle: "   "}}, meta).site_title,
    ).toBe("频道名");
    expect(
      themeContext({title: "频道名", _microfeed: {siteTitle: 42}}, meta).site_title,
    ).toBe("频道名");
    expect(
      themeContext({title: "频道名", _microfeed: {siteTitle: ["x"]}}, meta).site_title,
    ).toBe("频道名");
    expect(
      themeContext({title: "频道名", _microfeed: null}, meta).site_title,
    ).toBe("频道名");
  });

  test("前后空格被裁剪", () => {
    expect(
      themeContext({title: "频道名", _microfeed: {siteTitle: "  星河剑歌  "}}, meta).site_title,
    ).toBe("星河剑歌");
  });

  test("缺 title 时给空串而不是 undefined（模板可无条件渲染）", () => {
    const context = themeContext({}, meta);
    expect(context.site_title).toBe("");
    expect("site_title" in context).toBe(true);
  });
});

describe("站点标题的完整链路", () => {
  test("FeedPublicJsonBuilder 把 settings.webGlobalSettings.siteTitle 带进 _microfeed", () => {
    const extra = buildMicrofeedExtra({
      channel: {categories: [], title: "频道自身名"},
      settings: {webGlobalSettings: {siteTitle: "星河剑歌"}},
    });
    expect(extra.siteTitle).toBe("星河剑歌");
  });

  test("设置项为空串时原样带出，交给 themeContext 回退", () => {
    const extra = buildMicrofeedExtra({
      channel: {categories: [], title: "频道自身名"},
      settings: {webGlobalSettings: {siteTitle: ""}},
    });
    expect(extra.siteTitle).toBe("");
    expect(themeContext(buildPublicFeed({
      channel: {categories: [], title: "频道自身名"},
      settings: {webGlobalSettings: {siteTitle: ""}},
    }), meta).site_title).toBe("频道自身名");
  });

  test("settings 未配置时不下发 siteTitle，主题回退到频道标题", () => {
    const content = {
      channel: {categories: [], title: "频道自身名"},
      settings: {subscribeMethods: {methods: []}},
    };
    const extra = buildMicrofeedExtra(content);
    expect("siteTitle" in extra).toBe(false);
    expect(themeContext(buildPublicFeed(content), meta).site_title).toBe("频道自身名");
  });

  test("旧 channel._microfeed.siteTitle 口袋被 settings 压制", () => {
    const extra = buildMicrofeedExtra({
      channel: {
        _microfeed: {siteTitle: "旧口袋值"},
        categories: [],
        title: "频道自身名",
      },
      settings: {webGlobalSettings: {siteTitle: "星河剑歌"}},
    });
    expect(extra.siteTitle).toBe("星河剑歌");
  });

  test("清空设置项后旧 channel 口袋不得复活", () => {
    const content = {
      channel: {
        _microfeed: {siteTitle: "旧口袋值"},
        categories: [],
        title: "频道自身名",
      },
      settings: {webGlobalSettings: {}},
    };
    const extra = buildMicrofeedExtra(content);
    expect("siteTitle" in extra).toBe(false);
    expect(themeContext(buildPublicFeed(content), meta).site_title).toBe("频道自身名");
  });

  test("channel._microfeed 的其他键不受影响", () => {
    const extra = buildMicrofeedExtra({
      channel: {
        _microfeed: {siteTitle: "旧口袋值", serialStatus: "serializing"},
        categories: [],
        title: "频道自身名",
      },
      settings: {webGlobalSettings: {}},
    });
    expect(extra.serialStatus).toBe("serializing");
  });

  test("真实主题模板渲染出的 logo 用站点标题，而不是频道标题", () => {
    const html = Mustache.render(
      bodyStartTemplate(),
      themeContext({title: "频道自身名", _microfeed: {siteTitle: "星河剑歌"}}, meta),
    );
    expect(html).toContain('<span class="fq-logo-text">星河剑歌</span>');
    expect(html).not.toContain("频道自身名");
  });

  test("未配置时真实模板回退到频道标题", () => {
    const html = Mustache.render(
      bodyStartTemplate(),
      themeContext({title: "星河剑歌"}, meta),
    );
    expect(html).toContain('<span class="fq-logo-text">星河剑歌</span>');
  });
});
