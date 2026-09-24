/**
 * Worker tests for the novel content read API (ADR-0006).
 *
 * These assert external behaviour only: the HTTP status and the response JSON
 * shape. Authorization itself is covered by `login-credential.test.ts` (the
 * sessionless bearer decision) and `api-permissions.test.ts` (the code mapping);
 * here we care that each endpoint returns the right published data in the right
 * whitelisted shape.
 */

import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {
  getContentBookChapters,
  getContentCategories,
  getContentCategoryBooks,
  getContentChapter,
} from "@/server/api/content-read";
import FeedDb from "@/server/feed/FeedDb";
import {STATUSES} from "@/shared/Constants";

const ORIGIN = "https://feed.example.com";
const CATEGORY_A = "ctgyreadaa1";
const CATEGORY_HIDDEN = "ctgyreadhh1";
const BOOK_PUBLISHED = "bkreadaaa01";
const BOOK_DRAFT = "bkreaddft01";
const CHAPTER_1 = "chptrread01";
const CHAPTER_2 = "chptrread02";
const CHAPTER_UNFILED = "chptrread03";
const CHAPTER_DRAFT = "chptrread04";

function request(path: string): Request {
  return new Request(`${ORIGIN}${path}`);
}

async function seedCategory(id: string, name: string, visible: boolean): Promise<void> {
  await env.FEED_DB.prepare(
    "INSERT INTO ext_category (id, name, slug, parent_id, sort, visible, created_at) " +
      "VALUES (?, ?, ?, NULL, 0, ?, ?)",
  ).bind(id, name, `slug-${id}`, visible ? 1 : 0, Date.now()).run();
}

async function seedBook(id: string, genre: string, status: number): Promise<void> {
  await env.FEED_DB.prepare(
    "INSERT INTO channels (id, status, is_primary, data, created_at, updated_at, genre) " +
      "VALUES (?, ?, NULL, ?, ?, ?, ?)",
  )
    .bind(
      id,
      status,
      JSON.stringify({title: `Book ${id}`}),
      Date.now(),
      Date.now(),
      genre,
    )
    .run();
}

async function seedChapter(
  id: string,
  options: {
    bookId: string;
    status: number;
    title: string;
    description: string;
    volume?: string;
    volumeOrder?: number;
    chapterNo: number;
    pubDate?: string;
  },
): Promise<void> {
  await env.FEED_DB.prepare(
    "INSERT INTO items (id, status, data, pub_date, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      options.status,
      JSON.stringify({
        _microfeed: {
          bookId: options.bookId,
          chapterNo: options.chapterNo,
          volume: options.volume ?? "",
          ...(options.volumeOrder == null
            ? {}
            : {volumeOrder: options.volumeOrder}),
        },
        description: options.description,
        title: options.title,
      }),
      options.pubDate ?? "2026-01-01T00:00:00.000Z",
      Date.now(),
      Date.now(),
    )
    .run();
}

beforeEach(async () => {
  await env.FEED_DB.batch([
    env.FEED_DB.prepare("DELETE FROM items WHERE id LIKE 'chptrread%'"),
    env.FEED_DB.prepare("DELETE FROM channels WHERE id LIKE 'bkread%'"),
    env.FEED_DB.prepare("DELETE FROM ext_category WHERE id LIKE 'ctgyread%'"),
  ]);
});

describe("GET /api/v1/content/categories/", () => {
  it("returns visible categories with their published book counts", async () => {
    await seedCategory(CATEGORY_A, "东方玄幻", true);
    await seedCategory(CATEGORY_HIDDEN, "隐藏分类", false);
    await seedBook(BOOK_PUBLISHED, CATEGORY_A, STATUSES.PUBLISHED);
    await seedBook(BOOK_DRAFT, CATEGORY_A, STATUSES.UNPUBLISHED);

    const response = await getContentCategories({} as never);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      categories: Array<Record<string, unknown>>;
    };

    const ids = body.categories.map((category) => category.id);
    expect(ids).toContain(CATEGORY_A);
    expect(ids).not.toContain(CATEGORY_HIDDEN);
    // One published book counted; the unpublished one is not.
    expect(body.categories.find((c) => c.id === CATEGORY_A)?.bookCount).toBe(1);
  });

  it("returns exactly the whitelisted fields", async () => {
    await seedCategory(CATEGORY_A, "东方玄幻", true);

    const response = await getContentCategories({} as never);
    const body = await response.json() as {
      categories: Array<Record<string, unknown>>;
    };
    expect(Object.keys(body.categories[0]!).sort()).toEqual([
      "bookCount",
      "id",
      "name",
      "slug",
    ]);
    for (const leaked of ["parentId", "sort", "visible", "createdAt"]) {
      expect(body.categories[0]).not.toHaveProperty(leaked);
    }
  });
});

describe("GET /api/v1/content/categories/{categoryId}/books/", () => {
  it("returns the published books of a category, by id or by slug", async () => {
    await seedCategory(CATEGORY_A, "东方玄幻", true);
    await seedBook(BOOK_PUBLISHED, CATEGORY_A, STATUSES.PUBLISHED);
    await seedBook(BOOK_DRAFT, CATEGORY_A, STATUSES.UNPUBLISHED);

    const byId = await getContentCategoryBooks({
      params: {categoryId: CATEGORY_A},
      request: request(`/api/v1/content/categories/${CATEGORY_A}/books/`),
    } as never);
    expect(byId.status).toBe(200);
    const body = await byId.json() as {books: Array<{id: string}>};
    expect(body.books.map((book) => book.id)).toEqual([BOOK_PUBLISHED]);

    const bySlug = await getContentCategoryBooks({
      params: {categoryId: `slug-${CATEGORY_A}`},
      request: request("/api/v1/content/categories/x/books/"),
    } as never);
    expect(bySlug.status).toBe(200);
  });

  it("404s for a hidden or unknown category", async () => {
    await seedCategory(CATEGORY_HIDDEN, "隐藏分类", false);

    const hidden = await getContentCategoryBooks({
      params: {categoryId: CATEGORY_HIDDEN},
      request: request("/api/v1/content/categories/x/books/"),
    } as never);
    expect(hidden.status).toBe(404);

    const unknown = await getContentCategoryBooks({
      params: {categoryId: "nosuchcat01"},
      request: request("/api/v1/content/categories/x/books/"),
    } as never);
    expect(unknown.status).toBe(404);
  });
});

describe("GET /api/v1/content/books/{bookId}/chapters/", () => {
  it("returns a two-level volume → chapter catalog", async () => {
    await seedCategory(CATEGORY_A, "东方玄幻", true);
    await seedBook(BOOK_PUBLISHED, CATEGORY_A, STATUSES.PUBLISHED);
    await seedChapter(CHAPTER_1, {
      bookId: BOOK_PUBLISHED,
      chapterNo: 1,
      description: "<p>one</p>",
      status: STATUSES.PUBLISHED,
      title: "第一章",
      volume: "第一卷",
      volumeOrder: 1,
    });
    await seedChapter(CHAPTER_2, {
      bookId: BOOK_PUBLISHED,
      chapterNo: 1,
      description: "<p>two</p>",
      status: STATUSES.PUBLISHED,
      title: "第二卷第一章",
      volume: "第二卷",
      volumeOrder: 2,
    });
    await seedChapter(CHAPTER_UNFILED, {
      bookId: BOOK_PUBLISHED,
      chapterNo: 9,
      description: "<p>loose</p>",
      status: STATUSES.PUBLISHED,
      title: "未分卷",
    });
    await seedChapter(CHAPTER_DRAFT, {
      bookId: BOOK_PUBLISHED,
      chapterNo: 2,
      description: "<p>draft</p>",
      status: STATUSES.UNPUBLISHED,
      title: "草稿",
      volume: "第一卷",
    });

    const response = await getContentBookChapters({
      params: {bookId: BOOK_PUBLISHED},
      request: request(`/api/v1/content/books/${BOOK_PUBLISHED}/chapters/`),
    } as never);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      book: {id: string; title: string};
      truncated: boolean;
      volumes: Array<{name: string; chapters: Array<{id: string}>}>;
    };

    expect(body.book.id).toBe(BOOK_PUBLISHED);
    expect(body.truncated).toBe(false);
    // Volumes follow `volumeOrder`, and the unfiled bucket is always last.
    expect(body.volumes.map((volume) => volume.name)).toEqual([
      "第一卷",
      "第二卷",
      "",
    ]);
    // The draft never appears.
    const ids = body.volumes.flatMap((v) => v.chapters.map((c) => c.id));
    expect(ids).toContain(CHAPTER_1);
    expect(ids).not.toContain(CHAPTER_DRAFT);
    // Whitelisted chapter fields only.
    expect(Object.keys(body.volumes[0]!.chapters[0]!).sort()).toEqual([
      "chapterNo",
      "id",
      "pubDate",
      "title",
    ]);
  });

  it("404s for an unpublished or unknown book", async () => {
    await seedCategory(CATEGORY_A, "东方玄幻", true);
    await seedBook(BOOK_DRAFT, CATEGORY_A, STATUSES.UNPUBLISHED);

    const draft = await getContentBookChapters({
      params: {bookId: BOOK_DRAFT},
      request: request(`/api/v1/content/books/${BOOK_DRAFT}/chapters/`),
    } as never);
    expect(draft.status).toBe(404);

    const unknown = await getContentBookChapters({
      params: {bookId: "nosuchbk001"},
      request: request("/api/v1/content/books/x/chapters/"),
    } as never);
    expect(unknown.status).toBe(404);
  });
});

describe("GET /api/v1/content/chapters/{chapterId}/", () => {
  it("returns the stored body verbatim with its format", async () => {
    await seedCategory(CATEGORY_A, "东方玄幻", true);
    await seedBook(BOOK_PUBLISHED, CATEGORY_A, STATUSES.PUBLISHED);
    await seedChapter(CHAPTER_1, {
      bookId: BOOK_PUBLISHED,
      chapterNo: 3,
      description: "<p>晨雾未散，陆尘已站在城头。</p>",
      status: STATUSES.PUBLISHED,
      title: "第三章",
      volume: "第一卷",
    });

    const response = await getContentChapter({
      locals: {feedDb: new FeedDb(env, request("/api/v1/content/chapters/x/"))},
      params: {chapterId: CHAPTER_1},
      request: request(`/api/v1/content/chapters/${CHAPTER_1}/`),
    } as never);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual([
      "chapterNo",
      "contentFormat",
      "contentHtml",
      "id",
      "title",
      "volume",
    ]);
    expect(body.id).toBe(CHAPTER_1);
    expect(body.title).toBe("第三章");
    expect(body.chapterNo).toBe(3);
    expect(body.volume).toBe("第一卷");
    // Verbatim: exactly what is stored, with no markdown render.
    expect(body.contentHtml).toBe("<p>晨雾未散，陆尘已站在城头。</p>");
    expect(body.contentFormat).toBe("html");
  });

  it("404s for a draft chapter", async () => {
    await seedCategory(CATEGORY_A, "东方玄幻", true);
    await seedBook(BOOK_PUBLISHED, CATEGORY_A, STATUSES.PUBLISHED);
    await seedChapter(CHAPTER_DRAFT, {
      bookId: BOOK_PUBLISHED,
      chapterNo: 1,
      description: "<p>draft</p>",
      status: STATUSES.UNPUBLISHED,
      title: "草稿",
    });

    const response = await getContentChapter({
      locals: {feedDb: new FeedDb(env, request("/api/v1/content/chapters/x/"))},
      params: {chapterId: CHAPTER_DRAFT},
      request: request(`/api/v1/content/chapters/${CHAPTER_DRAFT}/`),
    } as never);
    expect(response.status).toBe(404);
  });

  it("404s when the chapter's book is unpublished", async () => {
    await seedCategory(CATEGORY_A, "东方玄幻", true);
    await seedBook(BOOK_DRAFT, CATEGORY_A, STATUSES.UNPUBLISHED);
    await seedChapter(CHAPTER_1, {
      bookId: BOOK_DRAFT,
      chapterNo: 1,
      description: "<p>orphan</p>",
      status: STATUSES.PUBLISHED,
      title: "已发布但书已下架",
    });

    const response = await getContentChapter({
      locals: {feedDb: new FeedDb(env, request("/api/v1/content/chapters/x/"))},
      params: {chapterId: CHAPTER_1},
      request: request(`/api/v1/content/chapters/${CHAPTER_1}/`),
    } as never);
    expect(response.status).toBe(404);
  });
});
