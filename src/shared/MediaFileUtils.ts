import {ENCLOSURE_CATEGORIES, SUPPORTED_ENCLOSURE_CATEGORIES} from "./Constants";

export function isValidMediaFile(mediaFile: any) {
  return mediaFile && mediaFile.category && mediaFile.url && mediaFile.url.trim();
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
