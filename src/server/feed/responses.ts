import {env} from "cloudflare:workers";

import {adminBasePath} from "@/shared/AdminPath";
import {getIdFromSlug} from "@/shared/StringUtils";
import {STATUSES} from "@/shared/Constants";
import FeedPublicRssBuilder from "@/server/feed/FeedPublicRssBuilder";
import Theme from "@/server/themes/Theme";
import {themeAssetBaseUrl} from "@/server/themes/ThemeAssets";
import type {FeedContent} from "@/types";
import {
  isPublicFeedOffline,
  loadPublishedFeed,
} from "./feed";
import {jsonResponse, notFoundResponse} from "@/server/http";
import {publicSiteFileResponse} from "@/server/site-files/public";

function feedUnavailable(
  request: Request,
  content: FeedContent,
): Response | null {
  if (isPublicFeedOffline(content)) {
    return notFoundResponse(request, {statusText: "Not Found"});
  }
  return null;
}

function onboardingRedirect(
  request: Request,
  onboardingRequiredOk: boolean,
): Response | null {
  if (onboardingRequiredOk) {
    return null;
  }
  return Response.redirect(
    new URL(adminBasePath(env.MICROFEED_ADMIN_PATH), request.url),
    302,
  );
}

function subscriptionDisabled(content: FeedContent, type: string): boolean {
  const methods = content.settings?.subscribeMethods?.methods ?? [];
  return methods.some(
    (method) =>
      method.type === type &&
      method.editable === false &&
      method.enabled === false,
  );
}

export async function jsonFeedResponse(
  request: Request,
  checkSubscription = true,
  itemSlug?: string,
  itemStatuses: number[] = [STATUSES.PUBLISHED, STATUSES.UNLISTED],
  checkAccessPolicy = true,
): Promise<Response> {
  const itemId = itemSlug ? getIdFromSlug(itemSlug) : undefined;
  if (itemSlug && !itemId) {
    return notFoundResponse(request);
  }
  const loaded = await loadPublishedFeed(env, request, itemId
    ? {
        limit: 1,
        queryKwargs: {
          id: itemId,
          "status__in": itemStatuses,
        },
      }
    : {});
  const unavailable = checkAccessPolicy
    ? feedUnavailable(request, loaded.content)
    : null;
  if (unavailable) {
    return unavailable;
  }
  const redirect = onboardingRedirect(request, loaded.onboarding.requiredOk);
  if (redirect) {
    return redirect;
  }
  if (checkSubscription && subscriptionDisabled(loaded.content, "json")) {
    return notFoundResponse(request);
  }
  if (itemId && loaded.publicFeed.items.length === 0) {
    return notFoundResponse(request);
  }
  return jsonResponse(loaded.publicFeed, {
    headers: {
      "access-control-allow-origin": "*",
      "content-type": "application/json;charset=UTF-8",
    },
  });
}

export async function rssFeedResponse(
  request: Request,
  itemSlug?: string,
): Promise<Response> {
  const itemId = itemSlug ? getIdFromSlug(itemSlug) : undefined;
  if (itemSlug && !itemId) {
    return notFoundResponse(request);
  }
  const loaded = await loadPublishedFeed(env, request, itemId
    ? {
        limit: 1,
        queryKwargs: {
          id: itemId,
          "status__in": [STATUSES.PUBLISHED, STATUSES.UNLISTED],
        },
      }
    : {});
  const unavailable = feedUnavailable(request, loaded.content);
  if (unavailable) {
    return unavailable;
  }
  const redirect = onboardingRedirect(request, loaded.onboarding.requiredOk);
  if (redirect) {
    return redirect;
  }
  if (subscriptionDisabled(loaded.content, "rss")) {
    return notFoundResponse(request);
  }
  if (itemId && loaded.publicFeed.items.length === 0) {
    return notFoundResponse(request);
  }

  const rss = new FeedPublicRssBuilder(
    loaded.publicFeed,
    new URL(request.url).origin,
  ).getRssData();
  return new Response(rss, {
    headers: {"content-type": "application/xml"},
  });
}

export async function rssStylesheetResponse(request: Request): Promise<Response> {
  const loaded = await loadPublishedFeed(env, request, {
    includeActiveTheme: true,
    limit: 1,
  });
  const theme = new Theme(
    loaded.publicFeed,
    loaded.content.settings,
    null,
    loaded.content.activeTheme,
    themeAssetBaseUrl(
      env,
      request.url,
      loaded.content.activeTheme?.assetOwnerThemeId,
      loaded.content.activeTheme?.bundle.assets,
      loaded.content.settings?.webGlobalSettings?.publicBucketUrl,
    ),
  );
  return new Response(theme.getRssStylesheet().stylesheet, {
    headers: {"content-type": "text/xsl"},
  });
}

export async function sitemapResponse(request: Request): Promise<Response> {
  return publicSiteFileResponse(env, request, "sitemap.xml");
}

export function publicFeedHead(): Response {
  return new Response("ok");
}
