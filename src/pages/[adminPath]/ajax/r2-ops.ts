import {cache, env, waitUntil} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, localizedError} from "../../../server/http";
import FeedDb from "@/server/feed/FeedDb";
import {
  parseDeleteImageRequest,
  scheduleBestEffortMediaDeletion,
} from "@/server/media/deletions";
import {createSignedUpload} from "@/server/media/uploads";
import {
  mediaBucket,
  mediaStorageUnavailableResponse,
} from "@/server/media/storage";
import type {UploadRequest} from "../../../types";
import type {PublicCachePurger} from "@/server/cache/public-cache";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

export const POST: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_ARTICLE_UPDATE, request, env.FEED_DB);
  if (guard) return guard;
  if (!mediaBucket(env)) {
    return mediaStorageUnavailableResponse();
  }
  const input = await request.json() as UploadRequest;
  try {
    return jsonResponse(await createSignedUpload(request, env, input));
  } catch (error) {
    return jsonResponse(
      {error: error instanceof Error ? error.message : "Invalid upload request."},
      {status: 400},
    );
  }
};

export async function deleteAdminImage(
  request: Request,
  runtimeEnv: Env,
  schedule: (promise: Promise<unknown>) => void,
  publicCachePurger?: PublicCachePurger,
): Promise<Response> {
  let rawInput: unknown;
  try {
    rawInput = await request.json();
  } catch {
    return localizedError(request, "errors.r2.invalidImageDeletion", 400);
  }
  const input = parseDeleteImageRequest(rawInput);
  if (!input) {
    return localizedError(request, "errors.r2.invalidImageDeletion", 400);
  }

  try {
    const storedImageUrl = input.target
      ? await new FeedDb(runtimeEnv, request, publicCachePurger)
        .removeImageMetadata(input.target)
      : null;
    const keys = scheduleBestEffortMediaDeletion(
      mediaBucket(runtimeEnv),
      [input.imageUrl, storedImageUrl],
      schedule,
    );
    return jsonResponse({deletedKeys: keys.length});
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      message: "Failed to remove image metadata",
    }));
    return localizedError(request, "errors.r2.metadataRemovalFailed", 500);
  }
}

export const DELETE: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_ARTICLE_UPDATE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  return deleteAdminImage(request, env, waitUntil, cache);
};
