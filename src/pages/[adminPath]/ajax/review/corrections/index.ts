import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, serviceError} from "@/server/http";
import type {CorrectionDb} from "@/server/feed/extContentCorrection";
import {listCorrections, submitCorrection} from "@/server/feed/extContentCorrection";

interface SubmitBody {
  actorId?: string | null;
  itemId?: string;
  proposedData?: Record<string, unknown>;
  reason?: string | null;
}

/** `GET ?itemId=<id>` lists that chapter's correction proposals and returns the
 *  chapter's current content so the proposal form can start from it. */
export const GET: APIRoute = async ({request}) => {
  const itemId = new URL(request.url).searchParams.get("itemId") ?? "";
  try {
    const db = env.FEED_DB as unknown as CorrectionDb;
    const [corrections, current] = await Promise.all([
      listCorrections(db, itemId),
      db.prepare("SELECT id, data FROM items WHERE id = ?").bind(itemId).first(),
    ]);
    let currentData: Record<string, unknown> | null = null;
    if (current && typeof current.data === "string") {
      try {
        currentData = JSON.parse(current.data) as Record<string, unknown>;
      } catch {
        currentData = null;
      }
    }
    return jsonResponse(
      {corrections, currentData},
      {headers: {"cache-control": "private, no-store"}},
    );
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};

/** `POST` proposes a fix. The chapter itself is not modified here. */
export const POST: APIRoute = async ({request}) => {
  const body = await request.json().catch(() => null) as SubmitBody | null;
  try {
    if (!body?.itemId || !body.proposedData) {
      throw new Error("errors.corrections.invalidInput");
    }
    const correction = await submitCorrection(
      env.FEED_DB as unknown as CorrectionDb,
      {
        itemId: body.itemId,
        proposedData: body.proposedData,
        reason: body.reason ?? null,
        submittedBy: body.actorId ?? null,
      },
    );
    return jsonResponse(correction, {status: 201});
  } catch (error) {
    const response = serviceError(error);
    if (response) return response;
    throw error;
  }
};
