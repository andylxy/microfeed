import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {CorrectionDb} from "@/server/feed/extContentCorrection";
import {
  approveCorrection,
  rejectCorrection,
} from "@/server/feed/extContentCorrection";

interface DecisionBody {
  action?: string;
  actorId?: string | null;
}

/**
 * `POST {action: "approve"}` confirms the latest proposed modification and
 * writes it back to the chapter's original storage location.
 * `POST {action: "reject"}` discards it; the chapter is left untouched.
 */
export const POST: APIRoute = async ({params, request}) => {
  const correctionId = params.correctionId ?? "";
  const body = await request.json().catch(() => null) as DecisionBody | null;
  try {
    const actorId = body?.actorId ?? null;
    if (body?.action === "reject") {
      return jsonResponse(
        await rejectCorrection(
          env.FEED_DB as unknown as CorrectionDb,
          correctionId,
          actorId,
        ),
      );
    }
    if (body?.action !== "approve") {
      throw new Error("errors.corrections.invalidInput");
    }
    return jsonResponse(
      await approveCorrection(
        env.FEED_DB as unknown as CorrectionDb,
        correctionId,
        actorId,
      ),
    );
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
