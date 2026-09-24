/**
 * `getBookChapters` reads through the denormalized `items.book_id` column with a
 * JSON fallback, so a chapter is never lost to a missing mirror.
 *
 * `book_id` is a derived copy of `data._microfeed.bookId` (ADR-0006): a condition
 * on a JSON path cannot use an index, so the column exists to make "chapters of
 * book X" an index lookup. Rows written before the backfill still have
 * `book_id IS NULL`, and those must keep resolving through the JSON.
 */

import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {getBookChapters} from "@/server/feed/extCategory";
import {STATUSES} from "@/shared/Constants";

const ORIGIN = "https://feed.example.com";
const BOOK_ID = "BkTestBook1";
const OTHER_BOOK_ID = "BkOtherBook";

interface Seed {
  /** The mirrored `items.book_id` value; `null` simulates a pre-backfill row. */
  mirror: string | null;
  chapterNo: number;
  id: string;
  pubDate: string;
  status: number;
  title: string;
}

const SEEDS: Seed[] = [
  {
    chapterNo: 1,
    id: "chapMirror1",
    mirror: BOOK_ID,
    pubDate: "2026-08-01T00:00:00.000Z",
    status: STATUSES.PUBLISHED,
    title: "第一章",
  },
  {
    // Written before the backfill: the mirror is NULL, only the JSON knows.
    chapterNo: 2,
    id: "chapLegacy2",
    mirror: null,
    pubDate: "2026-08-02T00:00:00.000Z",
    status: STATUSES.PUBLISHED,
    title: "第二章",
  },
  {
    chapterNo: 3,
    id: "chapOther03",
    mirror: OTHER_BOOK_ID,
    pubDate: "2026-08-03T00:00:00.000Z",
    status: STATUSES.PUBLISHED,
    title: "别家第三章",
  },
  {
    chapterNo: 4,
    id: "chapDraft04",
    mirror: BOOK_ID,
    pubDate: "2026-08-04T00:00:00.000Z",
    status: STATUSES.UNPUBLISHED,
    title: "草稿第四章",
  },
];

async function seed(): Promise<void> {
  await env.FEED_DB.prepare("DELETE FROM items WHERE id LIKE 'chap%'").run();
  await env.FEED_DB.batch(SEEDS.map((entry) =>
    env.FEED_DB.prepare(
      "INSERT INTO items (id, status, data, pub_date, book_id, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      entry.id,
      entry.status,
      JSON.stringify({
        _microfeed: {
          // Every row's JSON claims a book; only the other-book row claims another.
          bookId: entry.mirror === null ? BOOK_ID : entry.mirror,
          chapterNo: entry.chapterNo,
          volume: "第一卷",
        },
        description: `<p>${entry.title}</p>`,
        title: entry.title,
      }),
      entry.pubDate,
      entry.mirror,
      entry.pubDate,
      entry.pubDate,
    )
  ));
}

describe("getBookChapters book_id double-read", () => {
  beforeEach(seed);

  it("returns the same chapters whether the mirror is present or NULL", async () => {
    const chapters = await getBookChapters(env.FEED_DB, BOOK_ID, ORIGIN);
    expect(chapters.map((chapter) => chapter.id)).toEqual([
      "chapMirror1",
      "chapLegacy2",
    ]);
  });

  it("keeps the pre-backfill row reachable after its mirror is cleared", async () => {
    // Proves the JSON fallback is what finds it, not the column.
    await env.FEED_DB.prepare("UPDATE items SET book_id = NULL WHERE id = ?")
      .bind("chapMirror1")
      .run();
    const chapters = await getBookChapters(env.FEED_DB, BOOK_ID, ORIGIN);
    expect(chapters.map((chapter) => chapter.id)).toEqual([
      "chapMirror1",
      "chapLegacy2",
    ]);
  });

  it("excludes another book's chapters and unpublished ones", async () => {
    const ids = (await getBookChapters(env.FEED_DB, BOOK_ID, ORIGIN))
      .map((chapter) => chapter.id);
    expect(ids).not.toContain("chapOther03");
    expect(ids).not.toContain("chapDraft04");
  });

  it("still resolves the other book's own chapters", async () => {
    const ids = (await getBookChapters(env.FEED_DB, OTHER_BOOK_ID, ORIGIN))
      .map((chapter) => chapter.id);
    expect(ids).toEqual(["chapOther03"]);
  });
});
