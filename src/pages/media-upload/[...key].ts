import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse} from "../../server/http";
import {
  mediaBucket,
  mediaStorageUnavailableResponse,
} from "@/server/media/storage";
import {normalizeObjectKey, verifySignedUpload} from "@/server/media/uploads";
import {adminLanguageFromRequest} from "@/shared/AdminLanguage";
import {ALLOWED_MEDIA_UPLOAD_TYPES} from "@/shared/MediaFileUtils";
import {translate} from "@/shared/i18n";

const corsHeaders = {
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "PUT, OPTIONS",
  "access-control-allow-origin": "*",
};

export const PUT: APIRoute = async ({params, request, url}) => {
  const bucket = mediaBucket(env);
  if (!bucket) {
    return mediaStorageUnavailableResponse(corsHeaders);
  }
  const objectKey = params.key ? normalizeObjectKey(params.key) : null;
  const contentType = url.searchParams.get("content-type") ?? "";
  const sizeValue = url.searchParams.get("size") ?? "";
  if (!objectKey) {
    return new Response(
      translate(
        "errors.media.invalidPath",
        adminLanguageFromRequest(request),
      ),
      {status: 400},
    );
  }
  const valid = await verifySignedUpload(
    objectKey,
    url.searchParams.get("expires"),
    url.searchParams.get("signature"),
    env.UPLOAD_SIGNING_KEY,
    contentType,
    undefined,
    sizeValue,
  );
  if (!valid) {
    return new Response(
      translate(
        "errors.media.invalidOrExpiredUploadUrl",
        adminLanguageFromRequest(request),
      ),
      {status: 403},
    );
  }
  // A4: the signed `contentType` is authentic; reject anything outside the
  // upload allowlist before any bytes are stored.
  if (contentType && !ALLOWED_MEDIA_UPLOAD_TYPES.has(contentType.toLowerCase())) {
    return new Response(
      translate(
        "errors.media.unsupportedContentType",
        adminLanguageFromRequest(request),
      ),
      {status: 415},
    );
  }
  if (!request.body) {
    return new Response(
      translate(
        "errors.media.uploadBodyRequired",
        adminLanguageFromRequest(request),
      ),
      {status: 400},
    );
  }

  let body: ReadableStream = request.body;
  let piping: Promise<void> | undefined;
  if (sizeValue) {
    const fixedLength = new FixedLengthStream(Number(sizeValue));
    piping = request.body.pipeTo(fixedLength.writable);
    body = fixedLength.readable;
  }
  const put = bucket.put(objectKey, body, {
    // A4: only trust the authenticated (signed) content-type. When it is absent,
    // do not fall back to request.headers, which a caller could spoof; the
    // object is then served with `content-disposition: attachment`.
    httpMetadata: contentType ? {contentType} : undefined,
  });
  const [object] = await Promise.all([put, piping]);
  return jsonResponse(
    {etag: object?.httpEtag ?? null},
    {headers: corsHeaders},
  );
};

export const OPTIONS: APIRoute = () => new Response(null, {
  headers: corsHeaders,
  status: 204,
});

export const ALL: APIRoute = ({request}) => new Response(
  translate(
    "errors.media.methodNotAllowed",
    adminLanguageFromRequest(request),
  ),
  {headers: {allow: "PUT, OPTIONS"}, status: 405},
);
