import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {AuditDb} from "@/server/feed/extContentAudit";
import {listAuditChaptersHandler} from "@/server/admin/audit-handlers";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

/** `GET` lists every chapter that has an audit trail, most recently changed first. */
export const GET: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(locals, PERMISSION_CODES.CONTENT_AUDIT_READ, request, env.FEED_DB);
  if (guard) return guard;
  try {
    const payload = await listAuditChaptersHandler(
      env.FEED_DB as unknown as AuditDb,
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
