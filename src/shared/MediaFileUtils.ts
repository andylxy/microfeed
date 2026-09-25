import {ENCLOSURE_CATEGORIES, SUPPORTED_ENCLOSURE_CATEGORIES} from "./Constants";

// A4 (stored-XSS hardening): media is only served inline when its type is in this
// set. Everything else gets `content-disposition: attachment` so the browser
// downloads it instead of executing it. video/* and audio/* are safe to inline.
export const INLINE_SAFE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "application/pdf",
]);

// A4: upload allowlist. This is the union of the CLI's accepted media MIME types
// (packages/cli/src/media.ts MEDIA_TYPES). svg/html/js are deliberately excluded
// because they can carry script and would be a stored-XSS vector if inlined.
// Keep this set in sync with that CLI list.
export const ALLOWED_MEDIA_UPLOAD_TYPES: ReadonlySet<string> = new Set([
  "image/avif",
  "image/gif",
  "image/heic",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/x-canon-cr2",
  "audio/flac",
  "audio/mp4",
  "audio/mpeg",
  "video/mp4",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "text/plain",
]);

// A4: single-PUT R2 size ceiling (100 MiB), aligned with R2's per-object limit.
export const MAX_MEDIA_UPLOAD_BYTES = 100 * 1024 * 1024;

export function isInlineSafeMediaType(contentType: string): boolean {
  const type = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (!type) return false;
  if (INLINE_SAFE_MEDIA_TYPES.has(type)) return true;
  return type.startsWith("video/") || type.startsWith("audio/");
}

// A4: returns the `content-disposition` value to force for a given type, or null
// when the type is safe to render inline.
export function mediaContentDisposition(contentType: string): string | null {
  return isInlineSafeMediaType(contentType) ? null : "attachment";
}

// C6: second-line validation — the category must be a known enclosure
// category, and the URL must not carry a script-capable protocol. Stored URLs
// appear in four legitimate shapes (absolute https?://, site paths `/media/…`,
// env-prefixed bucket keys `production/media/…`, and bare legacy keys
// `media/…`), so instead of allowlisting shapes the check rejects the actual
// danger: `javascript:` / `data:` / any non-http(s) protocol. The primary
// sanitizer is getMediaFileFromUrl; this keeps the public JSON builder safe
// even when a caller hands it an unvalidated shape.
export function isValidMediaFile(mediaFile: any) {
  if (!mediaFile || !mediaFile.category || !mediaFile.url || !mediaFile.url.trim()) {
    return false;
  }
  if (!SUPPORTED_ENCLOSURE_CATEGORIES.includes(mediaFile.category)) {
    return false;
  }
  const url = mediaFile.url.trim();
  const hasProtocol = /^[a-z][a-z\d+.-]*:/iu.test(url);
  return !hasProtocol || /^https?:\/\//iu.test(url);
}

export function getMediaFileFromUrl(urlParams: any) {
  const category = urlParams.get('media_category');

  const mediaFile = {};

  const url = urlParams.get('media_url');
  if (url) {
    (mediaFile as any).url = url;
  }

  if (category) {
    (mediaFile as any).category = SUPPORTED_ENCLOSURE_CATEGORIES.includes(category) ? category : null;

    // `external_url` points at a linked web page, so text/html is the correct
    // type rather than a placeholder. Probing it with a HEAD request is not a
    // viable improvement: the fetch would be cross-origin, so CORS hides
    // Content-Type, and proxying it through the Worker would add an SSRF
    // surface for a value that is already right.
    if ((mediaFile as any).category === ENCLOSURE_CATEGORIES.EXTERNAL_URL) {
      (mediaFile as any).contentType = 'text/html';
    }
  }
  return mediaFile;
}
