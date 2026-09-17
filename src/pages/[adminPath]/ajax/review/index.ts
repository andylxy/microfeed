import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import {listReviewQueueHandler} from "@/server/admin/review-handlers";
import type {AuditDb} from "@/server/feed/extContentAudit";
import type {ReportDb} from "@/server/feed/extContentReport";

/** The review queue: chapters awaiting review plus pending reader reports. */
export const GET: APIRoute = async () => {
  try {
    const payload = await listReviewQueueHandler(
      env.FEED_DB as unknown as AuditDb & ReportDb,
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
