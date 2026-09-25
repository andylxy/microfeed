import {normalizeObjectKey} from "@/server/media/uploads";
import type {
  DeleteImageRequest,
  ImageMetadataTarget,
} from "@/types";

const MANAGED_MEDIA_PREFIXES = new Set([
  "development",
  "preview",
  "production",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseImageMetadataTarget(
  value: unknown,
): ImageMetadataTarget | null {
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }
  if (value.type === "favicon") {
    return {type: "favicon"};
  }
  if (value.type === "channel") {
    return typeof value.id === "string" && value.id.trim()
      ? {id: value.id.trim(), type: "channel"}
      : {type: "channel"};
  }
  if (
    value.type === "item" &&
    typeof value.id === "string" &&
    value.id.trim()
  ) {
    return {id: value.id.trim(), type: value.type};
  }
  return null;
}

export function parseDeleteImageRequest(
  value: unknown,
): DeleteImageRequest | null {
  if (
    !isRecord(value) ||
    typeof value.imageUrl !== "string" ||
    !value.imageUrl.trim()
  ) {
    return null;
  }
  if (value.target === undefined) {
    return {imageUrl: value.imageUrl.trim()};
  }
  const target = parseImageMetadataTarget(value.target);
  return target
    ? {imageUrl: value.imageUrl.trim(), target}
    : null;
}

export function managedMediaObjectKey(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  let path = value.trim();
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(path)) {
    return null;
  }
  path = path.replace(/^\/+media\//u, "");
  const key = normalizeObjectKey(path);
  const prefix = key?.split("/", 1)[0];
  if (!key || !prefix || !MANAGED_MEDIA_PREFIXES.has(prefix)) {
    return null;
  }
  return key;
}

/** Extract every `<img src="…">` URL from an HTML string (B20): deleting an
 * item must also reclaim the R2 objects its body embeds. Best-effort regex —
 * every URL is re-validated by {@link managedMediaObjectKey} before a delete. */
export function imageUrlsFromHtml(html: unknown): string[] {
  if (typeof html !== "string" || !html) {
    return [];
  }
  const urls: string[] = [];
  const imgPattern = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu;
  for (const match of html.matchAll(imgPattern)) {
    const url = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (url) {
      urls.push(url);
    }
  }
  return urls;
}

/** Every media URL an item references (B20): the main media attachments, the
 * cover image, and the images embedded in its HTML body. */
export function itemMediaUrls(
  item: Record<string, unknown> | null | undefined,
): string[] {
  if (!item) {
    return [];
  }
  const urls: string[] = [];
  const attachments = item.attachments;
  if (Array.isArray(attachments)) {
    for (const attachment of attachments) {
      if (attachment && typeof attachment === "object" &&
        typeof (attachment as Record<string, unknown>).url === "string") {
        urls.push((attachment as Record<string, unknown>).url as string);
      }
    }
  }
  if (typeof item.image === "string") {
    urls.push(item.image);
  }
  urls.push(...imageUrlsFromHtml(item.description));
  urls.push(...imageUrlsFromHtml(item.content_html));
  return urls;
}

export function scheduleBestEffortMediaDeletion(
  bucket: Pick<R2Bucket, "delete"> | null,
  imageUrls: unknown[],
  schedule: (promise: Promise<unknown>) => void,
): string[] {
  if (!bucket) {
    return [];
  }
  const keys = [...new Set(
    imageUrls
      .map((imageUrl) => managedMediaObjectKey(imageUrl))
      .filter((key): key is string => Boolean(key)),
  )];
  if (keys.length === 0) {
    return [];
  }

  schedule(
    bucket.delete(keys).catch((error: unknown) => {
      console.error(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        keyCount: keys.length,
        message: "Best-effort R2 image deletion failed",
      }));
    }),
  );
  return keys;
}
