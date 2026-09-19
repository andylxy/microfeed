import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import {listReviewQueueHandler} from "@/server/admin/review-handlers";
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
