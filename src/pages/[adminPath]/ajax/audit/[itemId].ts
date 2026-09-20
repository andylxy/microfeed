import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, localizedError, serviceError} from "@/server/http";
import type {AuditDb} from "@/server/feed/extContentAudit";
import {listAuditTrailHandler} from "@/server/admin/audit-handlers";
import {
  restoreItemVersionHandler,
  ReviewActionError,
} from "@/server/admin/review-handlers";

/** `GET` returns one chapter's full audit trail, oldest first. */
export const GET: APIRoute = async ({params}) => {
  const itemId = params.itemId ?? "";
  try {
    const payload = await listAuditTrailHandler(
      env.FEED_DB as unknown as AuditDb,
      itemId,
    );
    return jsonResponse(
      payload,
      {headers: {"cache-control": "private, no-store"}},
    );
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};

interface RestoreBody {
  auditRowId?: string;
}

/**
 * Put the chapter back to the version an audit row records. This is a write,
 * so it lives behind POST rather than being folded into the read above.
 */
export const POST: APIRoute = async ({params, request}) => {
  const itemId = params.itemId ?? "";
  const body = await request.json().catch(() => null) as RestoreBody | null;
  if (!body?.auditRowId) {
    return localizedError(request, "errors.review.invalidAction", 400);
  }
  try {
    const result = await restoreItemVersionHandler(
      request,
      env,
      itemId,
      body.auditRowId,
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
