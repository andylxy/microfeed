export const SITE_FILE_MAX_BYTES = 256 * 1024;
export const SITE_FILE_MAX_NAME_LENGTH = 128;
export const SITE_FILE_TEMPLATE_COLLECTION_LIMIT = 100;

export const SITE_FILE_GENERATORS = [
  "robots",
  "llms",
  "sitemap",
] as const;

export type SiteFileGenerator = typeof SITE_FILE_GENERATORS[number];

export const SITE_FILE_MEDIA_TYPES = [
  "application/json",
  "application/manifest+json",
  "application/rss+xml",
  "application/xml",
  "text/css",
  "text/csv",
  "text/markdown",
  "text/plain",
  "text/yaml",
] as const;

export type SiteFileMediaType = typeof SITE_FILE_MEDIA_TYPES[number];

const MEDIA_TYPE_BY_EXTENSION: Record<string, SiteFileMediaType> = {
  atom: "application/xml",
  css: "text/css",
  csv: "text/csv",
  json: "application/json",
  md: "text/markdown",
  rss: "application/rss+xml",
  txt: "text/plain",
  webmanifest: "application/manifest+json",
  xml: "application/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
};

const BLOCKED_SITE_FILE_NAMES = new Set([
  "favicon.ico",
  "openapi.json",
  "openapi.yaml",
]);

export interface SiteFileRecord {
  content_type: SiteFileMediaType;
  date_created: string;
  date_modified: string;
  date_published?: string;
  draft_content: string;
  enabled: boolean;
  filename: string;
  generator?: SiteFileGenerator;
  id: string;
  mode: "generated" | "override";
  published_content?: string;
  system: boolean;
  url: string;
}

export function normalizeSiteFilename(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/^\/+|\/+$/gu, "");
}

export function normalizeSiteFilenameInput(value: string): string {
  return normalizeSiteFilename(value.replace(/[\\/]/gu, ""))
    .slice(0, SITE_FILE_MAX_NAME_LENGTH);
}

export function siteFileMediaTypeForName(
  filename: string,
): SiteFileMediaType | undefined {
  const extension = normalizeSiteFilename(filename).split(".").at(-1) ?? "";
  return MEDIA_TYPE_BY_EXTENSION[extension];
}

/**
 * A validation failure expressed as an i18n key plus its parameters. Callers own
 * the translation: this module is shared with server code and therefore must not
 * import `@/client/*`.
 */
export interface SiteFileValidationIssue {
  key: string;
  params?: Record<string, string>;
}

export function validateSiteFilename(
  value: string,
): SiteFileValidationIssue | undefined {
  const filename = normalizeSiteFilename(value);
  if (!filename || filename.length > SITE_FILE_MAX_NAME_LENGTH) {
    return {
      key: "errors.siteFile.nameLength",
      params: {max: String(SITE_FILE_MAX_NAME_LENGTH)},
    };
  }
  if (
    filename.startsWith(".") ||
    filename.includes("..") ||
    filename.includes("/") ||
    !/^[a-z0-9][a-z0-9._-]*\.[a-z0-9]+$/u.test(filename)
  ) {
    return {key: "errors.siteFile.nameFormat"};
  }
  if (BLOCKED_SITE_FILE_NAMES.has(filename)) {
    return {key: "errors.siteFile.nameReserved", params: {filename}};
  }
  if (!siteFileMediaTypeForName(filename)) {
    return {key: "errors.siteFile.nameExtension"};
  }
  return undefined;
}

export function validateSiteFileContent(
  content: string,
  contentType: SiteFileMediaType,
  options: {allowLargeGeneratedSitemap?: boolean} = {},
): SiteFileValidationIssue | undefined {
  if (content.includes("\0")) return {key: "errors.siteFile.nulBytes"};
  if (
    !options.allowLargeGeneratedSitemap &&
    new TextEncoder().encode(content).byteLength > SITE_FILE_MAX_BYTES
  ) {
    return {
      key: "errors.siteFile.contentSize",
      params: {max: String(SITE_FILE_MAX_BYTES)},
    };
  }
  if (
    contentType === "application/json" ||
    contentType === "application/manifest+json"
  ) {
    try {
      JSON.parse(content);
    } catch {
      return {key: "errors.siteFile.invalidJson"};
    }
  }
  return undefined;
}

export function publicSiteFilePath(filename: string): string {
  return `/${normalizeSiteFilename(filename)}`;
}
