import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import {
  approveChapterHandler,
  listReviewQueueHandler,
  rejectChapterHandler,
} from "@/server/admin/review-handlers";
import type {AuditDb} from "@/server/feed/extContentAudit";
import {purgeWritebackCaches} from "@/server/feed/writeback-cache";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/** The review queue: chapters with unconfirmed content versions. */
export const GET: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_REVIEW_MANAGE, request, env.FEED_DB);
  if (guard) return guard;
  try {
    const payload = await listReviewQueueHandler(
      env.FEED_DB as unknown as AuditDb,
    );
    return jsonResponse(payload, {
      headers: {"cache-control": "private, no-store"},
    });
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    return jsonResponse(
      {error: String(error instanceof Error ? error.message : error)},
      {status: 500},
    );
  }
};

interface ReviewBody {
  action?: string;
  actorId?: string | null;
  itemId?: string;
}

/**
 * Confirm (`approve`) or discard (`reject`) a chapter's unconfirmed versions.
 *
 * Every failure answers with a readable message: an unrecognised exception used
 * to escape as an opaque 500 with no clue about the cause.
 */
export const POST: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_REVIEW_MANAGE, request, env.FEED_DB);
  if (guard) return guard;
  let body: ReviewBody | null = null;
  try {
    body = await request.json().catch(() => null) as ReviewBody | null;
    if (!body?.itemId || (body.action !== "approve" && body.action !== "reject")) {
      return jsonResponse(
        {
          error: "errors.review.invalidAction",
          received: {
            action: body?.action ?? null,
            itemId: body?.itemId ?? null,
          },
        },
        {status: 400},
      );
    }
    const db = env.FEED_DB as unknown as AuditDb;
    const result = body.action === "approve"
      ? await approveChapterHandler(db, body.itemId, body.actorId ?? null)
      : await rejectChapterHandler(db, body.itemId, body.actorId ?? null);

    // Confirming writes items.data directly, which bypasses the save path that
    // normally invalidates the public page cache. Without this the reader keeps
    // serving the pre-change content until some later edit happens to purge it —
    // which looked like "the confirm did nothing". The helper also clears the
    // App chapter-content bucket (ADR-0049 D3), which the CDN tags do not cover.
    await purgeWritebackCaches(env, request, body.itemId);

    return jsonResponse(result);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    return jsonResponse(
      {
        error: String(error instanceof Error ? error.message : error),
        stack: error instanceof Error ? (error.stack ?? null) : null,
      },
      {status: 500},
    );
  }
};
