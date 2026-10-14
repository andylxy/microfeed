import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, publicLocalizedError} from "@/server/http";
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
import {hasTcmMarker, markersToPlainText} from "@/shared/TcmMarkers";

export const GET: APIRoute = async ({request}) => {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  if (query.length < 2 || query.length > 200) {
    return publicLocalizedError(
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
    return publicLocalizedError(request, "errors.search.notFound", 404);
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
            book.author
              ? `${translate("search.authorPrefix", language)}${book.author}`
              : "",
            book.categoryName ?? "",
          ].filter(Boolean).join(" · "),
          id: `book-${book.id}`,
          // 书籍结果同样走纯文本出口（实测频道标题 0 标记，no-op 开销）
          title: markersToPlainText(book.title),
          type: "book" as const,
          type_label: typeLabel("book"),
          url: `/book/${book.id}`,
        })),
        ...response.items.map((item) => {
          // 标题与摘要走纯文本出口（标记外壳在结果列表里是噪声）。高亮切片按
          // 原始文本切分，会把外壳切碎（出现 "、杏子仁。 $f{" 这种半句）——
          // 带标记的条目弃用切片，客户端 appendExcerpt 有既有回退（无命中切片
          // → 整段纯文本摘要）。宁可丢 <mark>，不显示切碎的外壳。
          const rawTitle = String(item.title ?? "");
          const rawText = String(item.content_text ?? "");
          const markerised = hasTcmMarker(rawTitle) || hasTcmMarker(rawText);
          return {
            content_text: markersToPlainText(rawText),
            date_published: item.date_published,
            highlights: markerised ? undefined : item.highlights,
            id: item.id,
            title: markersToPlainText(rawTitle),
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
          };
        }),
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
