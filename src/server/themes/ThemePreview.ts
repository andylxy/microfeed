import {loadFeed, loadPublishedFeed} from "@/server/feed/feed";
import {adminLanguageFromRequest} from "@/shared/AdminLanguage";
import {translate} from "@/shared/i18n";
import FeedPublicRssBuilder from "@/server/feed/FeedPublicRssBuilder";
import Theme from "@/server/themes/Theme";
import {themeAssetBaseUrl} from "@/server/themes/ThemeAssets";
import type {
  StoredThemeVersion,
  ThemeDraft,
} from "@/shared/themes/ThemeContract";
import {themeRssPreviewDocument} from "@/shared/themes/RssPreview";
import type {PublicFeed} from "@/types";

type PreviewTheme = StoredThemeVersion | ThemeDraft;

function previewVersion(theme: PreviewTheme): StoredThemeVersion {
  if ("checksumSha256" in theme) return theme;
  return {
    assetOwnerThemeId: theme.assetOwnerThemeId,
    bundle: theme.bundle,
    checksumSha256: "0".repeat(64),
    createdAt: theme.createdAt,
    deletedAt: null,
    id: theme.id,
    manifest: theme.manifest,
    name: theme.name,
    originThemeId: theme.originThemeId,
    packageId: theme.packageId,
    previewFixture: theme.previewFixture,
    sourceCommit: null,
    sourceKind: "admin",
    sourcePath: null,
    sourceRef: null,
    sourceUrl: null,
    version: theme.version,
  };
}

function previewHeaders(
  requestUrl: string,
  contentType = "text/html; charset=utf-8",
): Headers {
  // A sandboxed iframe without allow-same-origin receives an opaque origin, so
  // CSP 'self' does not match even the site's own public images or theme assets.
  // Allow the exact request origin while keeping the iframe isolated from Admin.
  const requestOrigin = new URL(requestUrl).origin;
  return new Headers({
    "cache-control": "private, no-store",
    "content-security-policy": [
      "sandbox allow-scripts",
      `default-src ${requestOrigin} https: data: blob:`,
      `img-src ${requestOrigin} https: data: blob:`,
      `font-src ${requestOrigin} https: data:`,
      `script-src ${requestOrigin} https: 'unsafe-inline' 'unsafe-eval'`,
      `style-src ${requestOrigin} https: data: 'unsafe-inline'`,
      `connect-src ${requestOrigin} https:`,
    ].join("; "),
    "content-type": contentType,
    "referrer-policy": "no-referrer",
  });
}

export async function themePreviewResponse(
  runtimeEnv: Env,
  request: Request,
  previewTheme: PreviewTheme,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const view = requestUrl.searchParams.get("view") ?? "feed";
  const supportsPages = previewTheme.manifest.formatVersion === 2;
  if (
    !["feed", "item", "rss", "rss-stylesheet", "page"].includes(view) ||
    (!supportsPages && view === "page")
  ) {
    return new Response(
      translate(
        "errors.theme.unknownPreviewView",
        adminLanguageFromRequest(request),
      ),
      {status: 400},
    );
  }
  const requestedData = requestUrl.searchParams.get("data");
  if (
    requestedData !== null &&
    requestedData !== "fixture" &&
    requestedData !== "site"
  ) {
    return new Response(
      translate(
        "errors.theme.unknownPreviewDataSource",
        adminLanguageFromRequest(request),
      ),
      {status: 400},
    );
  }
  const dataSource = requestedData ??
    (previewTheme.previewFixture ? "fixture" : "site");
  if (dataSource === "fixture" && !previewTheme.previewFixture) {
    return new Response("This theme does not include a preview fixture.", {
      status: 400,
    });
  }
  const loaded = dataSource === "site"
    ? await loadPublishedFeed(runtimeEnv, request, {limit: 20})
    : await loadFeed(runtimeEnv, request, {includeItems: false});
  const publicFeed = (dataSource === "fixture"
    ? previewTheme.previewFixture
    : "publicFeed" in loaded ? loaded.publicFeed : null) as PublicFeed;
  const previewPublishedAt = publicFeed.items
    .map((item) => item.date_published)
    .find((value): value is string => typeof value === "string") ??
    new Date().toISOString();
  const storedTheme = previewVersion(previewTheme);
  const assetBaseUrl = themeAssetBaseUrl(
    runtimeEnv,
    request.url,
    storedTheme.assetOwnerThemeId,
    storedTheme.bundle.assets,
    loaded.content.settings?.webGlobalSettings?.publicBucketUrl,
  );
  const page = {
    content_html: "<p>This is a standalone Page preview.</p>",
    content_text: "This is a standalone Page preview.",
    date_created: previewPublishedAt,
    date_modified: previewPublishedAt,
    date_published: previewPublishedAt,
    id: "preview-page",
    is_not_found_page: false,
    meta_description: "Learn more about this site.",
    navigation_label: "About",
    navigation_order: 10,
    show_in_navigation: true,
    slug: "about",
    status: "published",
    title: "About",
    url: new URL("/about/", request.url).toString(),
  };
  const navigationPages = [
    page,
    {
      id: "preview-contact-page",
      navigation_label: "Contact",
      navigation_order: 20,
      slug: "contact",
      title: "Contact",
      url: new URL("/contact/", request.url).toString(),
    },
    {
      id: "preview-projects-page",
      navigation_label: "Projects",
      navigation_order: 30,
      slug: "projects",
      title: "Projects",
      url: new URL("/projects/", request.url).toString(),
    },
  ];
  const extraContext = {navigation_pages: navigationPages};
  const theme = new Theme(
    publicFeed,
    loaded.content.settings,
    null,
    storedTheme,
    assetBaseUrl,
    extraContext,
  );
  if (view === "rss-stylesheet") {
    return new Response(theme.getRssStylesheet().stylesheet, {
      headers: previewHeaders(request.url, "text/xsl; charset=utf-8"),
    });
  }
  if (view === "rss") {
    const stylesheet = theme.getRssStylesheet().stylesheet;
    const stylesheetUrl = new URL(request.url);
    stylesheetUrl.searchParams.set("view", "rss-stylesheet");
    stylesheetUrl.searchParams.set("data", dataSource);
    const rss = new FeedPublicRssBuilder(
      publicFeed,
      new URL(request.url).origin,
    ).getRssData().replace(
      /<\?xml-stylesheet href="[^"]+" type="text\/xsl"\?>/u,
      `<?xml-stylesheet href="${stylesheetUrl.href}" type="text/xsl"?>`,
    );
    return new Response(themeRssPreviewDocument(rss, stylesheet), {
      headers: previewHeaders(request.url),
    });
  }

  const shared = new Theme(
    publicFeed,
    loaded.content.settings,
    "shared",
    storedTheme,
    assetBaseUrl,
    extraContext,
  );
  const item = publicFeed.items[0] ?? {};
  const body = view === "item"
    ? theme.getWebItem(item).html
    : view === "page"
    ? theme.getWebPage(page, navigationPages).html
    : theme.getWebFeed().html;
  return new Response(
    `<!doctype html><html lang="${String(publicFeed.language ?? "en")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${shared.getWebHeader().html}${theme.getWebHeader().html}</head><body>${shared.getWebBodyStart().html}${theme.getWebBodyStart().html}${body}${shared.getWebBodyEnd().html}${theme.getWebBodyEnd().html}</body></html>`,
    {headers: previewHeaders(request.url)},
  );
}
