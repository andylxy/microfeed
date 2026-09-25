/**
 * Handlers for the novel content read API (ADR-0006).
 *
 * These answer the read-only, protected endpoints under `/api/v1/content/`,
 * which walk a reader down 标签 → 书 → 卷章 → 正文. They are deliberately thin:
 * each one reuses an existing feed query and then picks an explicit whitelist of
 * response fields, because the query shapes carry internal columns
 * (`parent_id`, `visible`, `created_at`) and a spread of `items.data` that must
 * not leak to a caller.
 *
 * Authorization is not handled here — the middleware decides it before the
 * route runs (see `requiredApiPermission` in `api-permissions.ts`). The pure
 * catalog shape lives in `src/shared/content-catalog.ts`.
 */

import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {bodyFormat} from "@/shared/BodyFormat";
import {buildCatalog, type FeedChapter} from "@/shared/content-catalog";
import {STATUSES} from "@/shared/Constants";
import {getIdFromSlug} from "@/shared/StringUtils";
import {
  getBookById,
  getBookChapters,
  getCategoryBySlugOrId,
  listCategoryNav,
  listChannelsByGenre,
} from "@/server/feed/extCategory";
import {jsonResponse, publicLocalizedError} from "@/server/http";

/** A catalog never returns more than this many chapters in one response. */
const MAX_CHAPTERS = 5000;

/** `GET /api/v1/content/categories/` — visible categories with published book counts. */
export const getContentCategories: APIRoute = async () => {
  const categories = await listCategoryNav(env.FEED_DB);
  return jsonResponse({
    categories: categories.map(({bookCount, id, name, slug}) => ({
      bookCount: bookCount ?? 0,
      id,
      name,
      slug,
    })),
  });
};

/** `GET /api/v1/content/categories/{categoryId}/books/` — published books in one category. */
export const getContentCategoryBooks: APIRoute = async ({params, request}) => {
  const category = await getCategoryBySlugOrId(env.FEED_DB, params.categoryId ?? "");
  // A category the public site would not render is not addressable here either:
  // `!category || !category.visible` is exactly the public page's own test.
  if (!category || !category.visible) {
    return publicLocalizedError(request, "errors.category.notFound", 404);
  }
  // `channels.genre` holds the category *id*, so pass the resolved id — not the
  // slug or id the caller happened to use.
  const books = await listChannelsByGenre(env.FEED_DB, category.id);
  return jsonResponse({books});
};

/** `GET /api/v1/content/books/{bookId}/chapters/` — the volume → chapter catalog. */
export const getContentBookChapters: APIRoute = async ({params, request}) => {
  const bookId = getIdFromSlug(params.bookId ?? "");
  // `getBookById` only returns published channels, so this doubles as the
  // "is the book available at all" check.
  const book = bookId ? await getBookById(env.FEED_DB, bookId) : null;
  if (!bookId || !book) {
    return publicLocalizedError(request, "errors.books.notFound", 404);
  }

  const all = (await getBookChapters(
    env.FEED_DB,
    bookId,
    new URL(request.url).origin,
  )) as FeedChapter[];

  return jsonResponse({
    ...buildCatalog(all, MAX_CHAPTERS),
    book: {id: book.id, title: book.title},
  });
};

/** `GET /api/v1/content/chapters/{chapterId}/` — one chapter, body verbatim. */
export const getContentChapter: APIRoute = async ({locals, params, request}) => {
  const chapterId = getIdFromSlug(params.chapterId ?? "");
  if (!chapterId || !locals.feedDb) {
    return publicLocalizedError(request, "errors.item.notFound", 404);
  }
  // Published chapters only — drafts and deleted items are not addressable.
  const item = await locals.feedDb.getItemById(chapterId, [STATUSES.PUBLISHED]);
  if (!item || typeof item !== "object") {
    return publicLocalizedError(request, "errors.item.notFound", 404);
  }

  const microfeed = (item._microfeed && typeof item._microfeed === "object"
    ? item._microfeed as Record<string, unknown>
    : {});
  const bookId = typeof microfeed.bookId === "string" ? microfeed.bookId : "";
  // A chapter of an unpublished book must not be readable on its own, so the
  // book is re-checked even though the chapter itself is published.
  const book = bookId ? await getBookById(env.FEED_DB, bookId) : null;
  if (!book) {
    return publicLocalizedError(request, "errors.books.notFound", 404);
  }

  const volume = typeof microfeed.volume === "string" ? microfeed.volume.trim() : "";
  const chapterNo = Number(microfeed.chapterNo ?? 0);

  return jsonResponse({
    chapterNo: Number.isFinite(chapterNo) ? chapterNo : 0,
    // The stored body, untouched: no markdown render, no re-render. Callers use
    // `contentFormat` to decide how to display it.
    contentFormat: bodyFormat(item.contentFormat ?? item.content_format),
    contentHtml: String(item.description ?? ""),
    id: String(item.id),
    title: typeof item.title === "string" ? item.title : "",
    volume,
  });
};
