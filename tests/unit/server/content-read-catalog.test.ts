/**
 * Unit tests for the catalog builder of the content read API (ADR-0006).
 *
 * The volume grouping and the chapter cap are pure, so they can be exercised
 * here without seeding thousands of rows; the endpoints that call it are covered
 * in `tests/worker/content-read-api.test.ts`.
 */

import {describe, expect, it} from "vitest";

import {buildCatalog, type FeedChapter} from "@/shared/content-catalog";

function chapter(
  id: string,
  options: {volume?: string; volumeOrder?: number; chapterNo: number; date?: string} = {
    chapterNo: 1,
  },
): FeedChapter {
  return {
    _microfeed: {
      bookId: "book1",
      chapterNo: options.chapterNo,
      volume: options.volume ?? "",
      ...(options.volumeOrder == null ? {} : {volumeOrder: options.volumeOrder}),
    },
    date_published: options.date ?? "2026-01-01T00:00:00.000Z",
    id,
    title: `Chapter ${id}`,
  };
}

describe("buildCatalog", () => {
  it("groups by volume and puts the unfiled bucket last", () => {
    const catalog = buildCatalog([
      chapter("a", {chapterNo: 1, volume: "第二卷", volumeOrder: 2}),
      chapter("b", {chapterNo: 1, volume: "第一卷", volumeOrder: 1}),
      chapter("c", {chapterNo: 9}),
    ], 5000);

    expect(catalog.truncated).toBe(false);
    expect(catalog.volumes.map((volume) => volume.name)).toEqual([
      "第一卷",
      "第二卷",
      "",
    ]);
  });

  it("caps the flat list before grouping and flags truncation", () => {
    const catalog = buildCatalog([
      chapter("a", {chapterNo: 1, volume: "第一卷"}),
      chapter("b", {chapterNo: 2, volume: "第一卷"}),
      chapter("c", {chapterNo: 3, volume: "第二卷"}),
    ], 2);

    expect(catalog.truncated).toBe(true);
    // Only the first two chapters survive, so the last volume is incomplete.
    expect(catalog.volumes.map((volume) => volume.name)).toEqual(["第一卷"]);
    expect(catalog.volumes[0]?.chapters.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("does not flag truncation at exactly the cap", () => {
    const catalog = buildCatalog([chapter("a"), chapter("b")], 2);
    expect(catalog.truncated).toBe(false);
  });

  it("returns only the whitelisted chapter fields", () => {
    const catalog = buildCatalog([chapter("a")], 5000);
    expect(Object.keys(catalog.volumes[0]!.chapters[0]!).sort()).toEqual([
      "chapterNo",
      "id",
      "pubDate",
      "title",
    ]);
  });

  it("omits pubDate when the chapter has none", () => {
    const orphan: FeedChapter = {_microfeed: {chapterNo: 1}, id: "x", title: "X"};
    const catalog = buildCatalog([orphan], 5000);
    expect(catalog.volumes[0]!.chapters[0]).not.toHaveProperty("pubDate");
  });
});
