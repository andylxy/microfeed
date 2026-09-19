import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import {
  approveChapterHandler,
  listReviewQueueHandler,
  rejectChapterHandler,
} from "@/server/admin/review-handlers";
import type {AuditDb} from "@/server/feed/extContentAudit";

/** The review queue: chapters awaiting a decision. */
export const GET: APIRoute = async () => {
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
    throw error;
  }
};

interface ReviewBody {
  action?: string;
  actorId?: string | null;
  itemId?: string;
}

/**
 * Confirm (`approve`) or undo (`reject`) a chapter's unconfirmed versions.
 * Rejecting restores the content captured before the earliest unconfirmed
 * change — it is a real rollback, not just a relabel.
 */
export const POST: APIRoute = async ({request}) => {
  const body = await request.json().catch(() => null) as ReviewBody | null;
  try {
    if (!body?.itemId || (body.action !== "approve" && body.action !== "reject")) {
      throw new Error("errors.review.invalidAction");
    }
    const db = env.FEED_DB as unknown as AuditDb;
    const result = body.action === "approve"
      ? await approveChapterHandler(db, body.itemId, body.actorId ?? null)
      : await rejectChapterHandler(db, body.itemId, body.actorId ?? null);
    return jsonResponse(result);
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
