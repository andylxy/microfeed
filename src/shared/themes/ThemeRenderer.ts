import Mustache from "mustache";

import {getBuiltInTemplateVariables} from "../TemplateVariables";
import type {
  ThemeBundleV1,
  ThemeContext,
  ThemeManifestV1,
  ThemePreviewFixture,
} from "./ThemeContract";
import {THEME_FILE_KEYS} from "./ThemeContract";
import {THEME_FILE_KEYS_V1} from "./ThemeContract";

export interface ThemeRuntimeMetadata {
  assetBaseUrl: string;
  packageId: string;
  version: string;
}

export function themeContext(
  publicFeed: Record<string, unknown>,
  metadata: ThemeRuntimeMetadata,
  item?: Record<string, unknown>,
): ThemeContext {
  const siteTitle = resolveSiteTitle(publicFeed);
  return {
    ...publicFeed,
    ...getBuiltInTemplateVariables(),
    _theme: {
      asset_base_url: metadata.assetBaseUrl,
      package_id: metadata.packageId,
      version: metadata.version,
    },
    ...(item ? {item} : {}),
    // novel-cms: an Admin-configured site title wins over the channel title.
    // Always populated (falls back to `title`) so themes can render it
    // unconditionally; the channel name itself stays untouched.
    site_title: siteTitle || String(publicFeed.title ?? ""),
  } as ThemeContext;
}

/** Read the Admin-configured site title. The value comes from
 *  `settings.webGlobalSettings.siteTitle`, which FeedPublicJsonBuilder already
 *  writes into the public feed's `_microfeed` pocket (and drops when unset).
 *  Returns "" when unset, blank or of the wrong type, so the caller can fall
 *  back to the channel title. */
function resolveSiteTitle(publicFeed: Record<string, unknown>): string {
  const microfeed = publicFeed._microfeed;
  if (
    microfeed === null ||
    typeof microfeed !== "object" ||
    Array.isArray(microfeed)
  ) {
    return "";
  }
  const value = (microfeed as Record<string, unknown>).siteTitle;
  return typeof value === "string" ? value.trim() : "";
}

export function parseThemeBundle(bundle: ThemeBundleV1): void {
  const keys = bundle.webPage !== undefined || bundle.webSearch !== undefined
    ? THEME_FILE_KEYS
    : THEME_FILE_KEYS_V1;
  for (const key of keys) {
    Mustache.parse(bundle[key] ?? "");
  }
}

export function renderThemeTemplate(
  template: string,
  context: Record<string, unknown>,
): string {
  return Mustache.render(template, context);
}

export function renderThemeSlot(
  bundle: ThemeBundleV1,
  slot: Exclude<keyof ThemeBundleV1, "assets">,
  context: Record<string, unknown>,
): string {
  return renderThemeTemplate(bundle[slot] ?? "", context);
}

export function canonicalThemePackage(
  manifest: ThemeManifestV1,
  bundle: ThemeBundleV1,
  previewFixture?: ThemePreviewFixture | null,
): string {
  const orderedBundle = Object.fromEntries(Object.entries({
    ...bundle,
    assets: bundle.assets.map(({key: _key, ...asset}) => asset),
  }).sort(([left], [right]) => left.localeCompare(right)));
  return JSON.stringify({
    manifest,
    bundle: orderedBundle,
    ...(previewFixture ? {previewFixture} : {}),
  });
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const source = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value;
  const bytes = new Uint8Array(source);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
