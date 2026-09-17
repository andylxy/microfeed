import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, localizedError, serviceError} from "@/server/http";
import {resolveReportHandler} from "@/server/admin/review-handlers";
import {
  REPORT_STATUSES,
  type ReportDb,
  type ReportStatus,
} from "@/server/feed/extContentReport";

/** Mark a reader report resolved or dismissed. */
export const POST: APIRoute = async ({params, request}) => {
  const reportId = params.reportId ?? "";
  const body = await request.json().catch(() => null) as {status?: string} | null;
  const status = body?.status as ReportStatus;
  if (!body || !REPORT_STATUSES.includes(status)) {
    return localizedError(request, "errors.review.invalidReportStatus", 400);
  }

  try {
    await resolveReportHandler(
      env.FEED_DB as unknown as ReportDb,
      reportId,
      status,
    );
    return jsonResponse({status});
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
