import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, localizedError} from "@/server/http";
import {loadPublishedFeed, shouldHidePublicWeb} from "@/server/feed/feed";
import {
  ItemSearchRequestError,
  ItemSearchUnavailableError,
  searchContent,
} from "@/server/items/search";
import {searchPublishedBooks} from "@/server/feed/extCategory";
import type {CategoryDb} from "@/server/feed/extCategory";
import {languageFromAcceptLanguage} from "@/shared/AdminLanguage";
import {translate} from "@/shared/i18n";
import {
  activeThemeSearchItemDestination,
  themeSupportsPagesAndSearch,
} from "@/server/themes/Theme";
import {buildAudioUrlWithTracking} from "@/shared/StringUtils";
import {resolveThemeSearchItemUrl} from "@/shared/themes/ThemeSearch";

export const GET: APIRoute = async ({request}) => {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  if (query.length < 2 || query.length > 200) {
    return localizedError(
      request,
      "errors.search.queryLength",
      400,
      undefined,
      {headers: {"cache-control": "private, no-store"}},
    );
  }
  const loaded = await loadPublishedFeed(env, request, {
    includeActiveTheme: true,
    limit: 1,
  });
  if (
    shouldHidePublicWeb(loaded.content) ||
    !themeSupportsPagesAndSearch(loaded.content.activeTheme)
  ) {
    return localizedError(request, "errors.search.notFound", 404);
  }
  try {
    const searchItemDestination = activeThemeSearchItemDestination(
      loaded.content.activeTheme,
    );
    const trackingUrls = loaded.content.settings?.analytics?.urls ?? [];
    const response = await searchContent(loaded.database.FEED_DB, request, {
      fields: ["title", "content"],
      limit: 12,
      publicBucketUrl:
        loaded.content.settings?.webGlobalSettings?.publicBucketUrl,
      query,
      statuses: ["published"],
      types: ["item", "page"],
    });
    // Books are not in the item/page search index, so look them up separately
    // and surface them first: someone typing a book title or an author name
    // wants the book, not a chapter that happens to contain the word.
    const books = await searchPublishedBooks(
      loaded.database.FEED_DB as unknown as CategoryDb,
      query,
    );
    // The result list is rendered by shared app JS that has no language of its
    // own, so the type label is resolved here. It follows the SITE language
    // (the surrounding page is rendered in it) and only falls back to the
    // visitor's Accept-Language when the channel declares none.
    const language = languageFromAcceptLanguage(
      String(loaded.publicFeed.language ?? "") ||
        request.headers.get("accept-language"),
    );
    const typeLabel = (type: string) =>
      translate(`search.resultType.${type}`, language);
    return jsonResponse({
      items: [
        ...books.map((book) => ({
          content_text: [
            book.author ? `作者：${book.author}` : "",
            book.categoryName ?? "",
          ].filter(Boolean).join(" · "),
          id: `book-${book.id}`,
          title: book.title,
          type: "book" as const,
          type_label: typeLabel("book"),
          url: `/book/${book.id}`,
        })),
        ...response.items.map((item) => ({
          content_text: item.content_text,
          date_published: item.date_published,
          highlights: item.highlights,
          id: item.id,
          title: item.title,
          type: item.type,
          type_label: typeLabel(item.type),
          url: item.type === "item"
            ? resolveThemeSearchItemUrl(searchItemDestination, {
                attachmentUrl: item.attachment_url
                  ? buildAudioUrlWithTracking(item.attachment_url, trackingUrls)
                  : undefined,
                itemUrl: item.item_url,
                webUrl: item.web_url,
              })
            : item.web_url,
        })),
      ],
    }, {headers: {"cache-control": "private, no-store"}});
  } catch (error) {
    if (error instanceof ItemSearchRequestError) {
      return jsonResponse({error: error.message}, {status: 400});
    }
    if (error instanceof ItemSearchUnavailableError) {
      return jsonResponse({error: error.message}, {status: 503});
    }
    throw error;
  }
};
