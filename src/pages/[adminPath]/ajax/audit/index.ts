import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {AuditDb} from "@/server/feed/extContentAudit";
import {listAuditChaptersHandler} from "@/server/admin/audit-handlers";

/** `GET` lists every chapter that has an audit trail, most recently changed first. */
export const GET: APIRoute = async () => {
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
