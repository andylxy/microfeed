import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, localizedError} from "@/server/http";
import {loadPublishedFeed, shouldHidePublicWeb} from "@/server/feed/feed";
import {
  ItemSearchRequestError,
  ItemSearchUnavailableError,
  searchContent,
} from "@/server/items/search";
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
    return jsonResponse({
      items: response.items.map((item) => ({
        content_text: item.content_text,
        date_published: item.date_published,
        highlights: item.highlights,
        id: item.id,
        title: item.title,
        type: item.type,
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
