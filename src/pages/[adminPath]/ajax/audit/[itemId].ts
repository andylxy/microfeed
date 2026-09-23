import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, localizedError, serviceError} from "@/server/http";
import type {AuditDb} from "@/server/feed/extContentAudit";
import {
  listAuditTrailHandler,
  setAuditRowArchivedHandler,
} from "@/server/admin/audit-handlers";
import {
  restoreItemVersionHandler,
  ReviewActionError,
} from "@/server/admin/review-handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/** `GET` returns one chapter's full audit trail, oldest first. */
export const GET: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_AUDIT_READ, request, env.FEED_DB);
  if (guard) return guard;
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

interface ActionBody {
  /** Restore the chapter to the version this row records. */
  auditRowId?: string;
  /** Hide a row from the listing, or bring a hidden one back. */
  archiveRowId?: string;
  archived?: boolean;
}

/**
 * Restore a version, or archive/unarchive one row. Both are writes, so they
 * live behind POST rather than being folded into the read above.
 */
export const POST: APIRoute = async ({locals, params, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_AUDIT_READ, request, env.FEED_DB);
  if (guard) return guard;
  const itemId = params.itemId ?? "";
  const body = await request.json().catch(() => null) as ActionBody | null;

  if (body?.archiveRowId) {
    try {
      const result = await setAuditRowArchivedHandler(
        env.FEED_DB as unknown as AuditDb,
        itemId,
        body.archiveRowId,
        body.archived === true,
      );
      if (!result.found) {
        return localizedError(request, "errors.review.invalidAction", 404);
      }
      return jsonResponse(result);
    } catch (error) {
      const response = serviceError(error);
      if (response) return response;
      throw error;
    }
  }

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
