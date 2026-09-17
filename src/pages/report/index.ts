import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, publicLocalizedError} from "@/server/http";
import {createReport, type ReportDb} from "@/server/feed/extContentReport";
import type {AuditDb} from "@/server/feed/extContentAudit";

/**
 * Anonymous reader report intake.
 *
 * Deliberately NOT part of the public API: it lives at /report rather than
 * under /api, and it is absent from OpenApiDocument.ts and ApiSchemas.ts, so
 * the published API contract (a hard rule in the novel-cms design) stays
 * untouched. Readers are not authenticated, so the endpoint only accepts a
 * report for a chapter that actually exists.
 */

interface ReportBody {
  itemId?: string;
  category?: string;
  detail?: string;
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // Same-origin form posts may omit Origin.
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export const POST: APIRoute = async ({request}) => {
  if (!sameOrigin(request)) {
    return publicLocalizedError(request, "errors.report.crossOrigin", 403);
  }

  const body = await request.json().catch(() => null) as ReportBody | null;
  const itemId = typeof body?.itemId === "string" ? body.itemId.trim() : "";
  if (!body || !itemId) {
    return publicLocalizedError(request, "errors.report.itemRequired", 400);
  }

  const db = env.FEED_DB as unknown as ReportDb & AuditDb;
  const row = await db
    .prepare("SELECT id FROM items WHERE id = ?")
    .bind(itemId)
    .first();
  if (row == null) {
    return publicLocalizedError(request, "errors.report.itemMissing", 404);
  }

  const id = await createReport(db, {
    category: String(body.category ?? "other"),
    detail: String(body.detail ?? ""),
    itemId,
    reporterType: "anonymous",
  });

  return jsonResponse({id, status: "pending"}, {status: 201});
};
