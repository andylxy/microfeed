import {cache, env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {CorrectionDb} from "@/server/feed/extContentCorrection";
import FeedDb from "@/server/feed/FeedDb";
import {PUBLIC_CACHE_TAGS} from "@/server/cache/public-cache";
import {
  approveCorrection,
  rejectCorrection,
} from "@/server/feed/extContentCorrection";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

interface DecisionBody {
  action?: string;
  actorId?: string | null;
}

/**
 * `POST {action: "approve"}` confirms the latest proposed modification and
 * writes it back to the chapter's original storage location.
 * `POST {action: "reject"}` discards it; the chapter is left untouched.
 */
export const POST: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_REVIEW_MANAGE, request, env.FEED_DB);
  if (guard) return guard;
  const correctionId = params.correctionId ?? "";
  const body = await request.json().catch(() => null) as DecisionBody | null;
  try {
    const actorId = body?.actorId ?? null;
    if (body?.action === "reject") {
      return jsonResponse(
        await rejectCorrection(
          env.FEED_DB as unknown as CorrectionDb,
          correctionId,
          actorId,
        ),
      );
    }
    if (body?.action !== "approve") {
      throw new Error("errors.corrections.invalidInput");
    }
    const applied = await approveCorrection(
      env.FEED_DB as unknown as CorrectionDb,
      correctionId,
      actorId,
    );
    // Writing the correction back updates items.data directly, skipping the save
    // path that invalidates the public cache, so the reader would keep showing
    // the pre-correction text. Purge here.
    const feedDb = new FeedDb(env, request, cache);
    await feedDb.purgePublicCacheTags([
      PUBLIC_CACHE_TAGS.PUBLIC,
      PUBLIC_CACHE_TAGS.ITEMS,
      PUBLIC_CACHE_TAGS.CHANNEL_PRIMARY,
      PUBLIC_CACHE_TAGS.item(applied.itemId),
    ]);
    return jsonResponse(applied);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
