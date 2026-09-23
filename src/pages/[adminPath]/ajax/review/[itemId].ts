import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, localizedError, serviceError} from "@/server/http";
import {
  applyReviewActionHandler,
  listItemAuditHandler,
  restoreItemVersionHandler,
  ReviewActionError,
} from "@/server/admin/review-handlers";
import type {AuditDb} from "@/server/feed/extContentAudit";
import type {ReviewAction} from "@/server/feed/extReview";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

const REVIEW_ACTIONS: readonly ReviewAction[] = [
  "submit",
  "approve",
  "reject",
  "takedown",
];

/** One chapter's audit trail. */
export const GET: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_REVIEW_MANAGE, request, env.FEED_DB);
  if (guard) return guard;
  const itemId = params.itemId ?? "";
  try {
    const payload = await listItemAuditHandler(
      env.FEED_DB as unknown as AuditDb,
      itemId,
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

interface ActionBody {
  action?: string;
  auditRowId?: string;
  reason?: string | null;
}

/** Move a chapter through the review state machine, or restore a version. */
export const POST: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_REVIEW_MANAGE, request, env.FEED_DB);
  if (guard) return guard;
  const itemId = params.itemId ?? "";
  const body = await request.json().catch(() => null) as ActionBody | null;
  if (!body || typeof body !== "object") {
    return localizedError(request, "errors.review.invalidAction", 400);
  }

  try {
    if (body.auditRowId) {
      const result = await restoreItemVersionHandler(
        request,
        env,
        itemId,
        body.auditRowId,
      );
      return jsonResponse(result);
    }

    const action = body.action as ReviewAction;
    if (!REVIEW_ACTIONS.includes(action)) {
      return localizedError(request, "errors.review.invalidAction", 400);
    }
    const result = await applyReviewActionHandler(
      request,
      env,
      itemId,
      action,
      body.reason,
    );
    return jsonResponse(result);
  } catch (error) {
    if (error instanceof ReviewActionError) {
      return localizedError(request, error.message, error.status);
    }
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
