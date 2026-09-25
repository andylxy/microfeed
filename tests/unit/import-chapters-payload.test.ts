/**
 * A3 guardrail: the "txt 分章导入" tool must persist chapter bodies and a valid
 * publish time. Before the fix it sent `content` (which `FeedCrudManager` ignores
 * → body dropped) and no `date_published_ms` (which made `FeedDb` call
 * `msToRFC3339(undefined)` → RangeError → 500 on every chapter). This test pins
 * the payload shape and proves it survives the `FeedCrudManager` mapping.
 */

import {describe, expect, it} from "vitest";

import FeedCrudManager from "@/server/feed/FeedCrudManager";
import {
  buildChapterImportItem,
  type ChapterDraft,
} from "@/shared/novelChapterImport";
import {STATUSES} from "@/shared/Constants";

const DRAFT: ChapterDraft = {
  title: "第一章 起始",
  content: "<p>正文内容</p>",
  volume: "第一卷",
  chapterNo: 1,
};

describe("buildChapterImportItem (A3)", () => {
  it("sends the body as content_html with an explicit format", () => {
    const item = buildChapterImportItem(DRAFT, 1_700_000_000_000, STATUSES.PUBLISHED);
    expect(item).toMatchObject({
      content_html: "<p>正文内容</p>",
      content_format: "html",
      title: "第一章 起始",
      status: STATUSES.PUBLISHED,
      type: "text",
    });
    // The old `content` field must be gone — `FeedCrudManager` would ignore it.
    expect(item).not.toHaveProperty("content");
  });

  it("carries the volume / chapterNo into _microfeed", () => {
    const item = buildChapterImportItem(DRAFT, 1_700_000_000_000, STATUSES.PUBLISHED);
    expect(item._microfeed).toMatchObject({volume: "第一卷", chapterNo: 1});
  });

  it("spaces chapters by index so they sort in serial order", () => {
    const a = buildChapterImportItem(DRAFT, 1_000, STATUSES.PUBLISHED);
    const b = buildChapterImportItem(DRAFT, 2_000, STATUSES.PUBLISHED);
    expect(typeof a.date_published_ms).toBe("number");
    expect(b.date_published_ms).toBeGreaterThan(a.date_published_ms as number);
  });
});

describe("chapter payload survives FeedCrudManager mapping (A3)", () => {
  it("produces a non-empty description and a numeric pubDateMs", () => {
    const item = buildChapterImportItem(DRAFT, 1_700_000_000_000, STATUSES.PUBLISHED);
    // No server-only state is touched for an item without image/attachment, so a
    // default-constructed manager is sufficient to exercise the mapping.
    const manager = new FeedCrudManager();
    const internal = manager._publicToInternalSchemaForItem(item);
    expect(internal.description).toBe("<p>正文内容</p>");
    expect(typeof internal.pubDateMs).toBe("number");
    expect(internal.pubDateMs).toBe(1_700_000_000_000);
    expect(internal.content_format).toBe("html");
  });

  it("keeps the create path dated while leaving an omitted update date alone", () => {
    // A3's mapper-level `?? Date.now()` default was reverted (§14.1): it broke
    // the documented "an update that omits a date preserves the stored one"
    // contract. The import flow never needed it — every payload this module
    // builds carries a numeric date_published_ms, which is what keeps
    // msToRFC3339 from seeing `undefined`.
    const item = buildChapterImportItem(DRAFT, 1_700_000_000_000, STATUSES.PUBLISHED);
    expect(typeof item.date_published_ms).toBe("number");

    // And the mapper itself must NOT invent one, or a patch would overwrite the
    // stored publication date.
    const manager = new FeedCrudManager();
    const internal = manager._publicToInternalSchemaForItem({
      title: "x",
      content_html: "<p>y</p>",
    });
    expect(internal.pubDateMs).toBeUndefined();
  });
});
