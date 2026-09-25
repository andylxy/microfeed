import {cache, env, waitUntil} from "cloudflare:workers";
import type {APIRoute} from "astro";

import FeedDb from "@/server/feed/FeedDb";
import {
  listPendingChapters,
  recordContentChange,
  rejectChapterVersions,
} from "@/server/feed/extContentReview";
import type {AuditDb} from "@/server/feed/extContentAudit";
import {itemMediaUrls, scheduleBestEffortMediaDeletion} from "@/server/media/deletions";
import {mediaBucket} from "@/server/media/storage";
import {jsonResponse, localizedError} from "../../../server/http";
import type {FeedContent} from "../../../types";
import type {PublicCachePurger} from "@/server/cache/public-cache";
import {PERMISSION_CODES, SETTINGS_CATEGORIES, STATUSES} from "@/shared/Constants";
import {webhookChannelSnapshot} from "@/shared/WebhookExamples";
import {
  changedWebhookFields,
  contentMutationWebhookInputs,
  webhookItemObject,
} from "@/server/webhooks/emission";
import {commitMutationWithWebhookEvents} from "@/server/webhooks/events";
import {
  isUnpublishedStatus,
  isWebMcpInteraction,
} from "@/shared/WebMcp";
import {requireRbac} from "@/server/rbac/guard";

export async function updateAdminFeed(
  request: Request,
  runtimeEnv: Env,
  schedule: (promise: Promise<unknown>) => void,
  publicCachePurger?: PublicCachePurger,
): Promise<Response> {
  const updatedFeed = await request.json().catch(() => null) as
    | FeedContent
    | null;
  if (!updatedFeed || typeof updatedFeed !== "object") {
    return localizedError(request, "errors.feed.validUpdate", 400);
  }
  const webMcpInteraction = isWebMcpInteraction(request);
  const updatedItemId = updatedFeed.item?.id;
  if (
    webMcpInteraction &&
    (typeof updatedItemId !== "string" || !updatedItemId.trim())
  ) {
    return localizedError(request, "errors.feed.chooseDraft", 400);
  }
  if (webMcpInteraction && (
    !updatedFeed.item || updatedFeed.channel || updatedFeed.settings ||
    !isUnpublishedStatus(updatedFeed.item.status)
  )) {
    return localizedError(request, "errors.feed.webmcpUnpublishedOnly", 409);
  }
  const deleteImageUrls = Array.isArray(updatedFeed.deleteImageUrls)
    ? updatedFeed.deleteImageUrls
    : [];
  const database = new FeedDb(runtimeEnv, request, publicCachePurger);
  // The content-review switch, read BEFORE anything is written. This same
  // request may itself flip the switch (a settings save), so the pre-write
  // value is both the gate for item saves landing in this request and the
  // "was enabled" side of the on→off transition below.
  const contentReviewBefore = await database.getSettingsCategory<{
    enabled?: boolean;
  }>(SETTINGS_CATEGORIES.CONTENT_REVIEW);
  const reviewWasEnabled = contentReviewBefore?.enabled === true;
  const [beforeItem, beforeChannelContent] = await Promise.all([
    updatedItemId ? database.getItemById(updatedItemId) : null,
    updatedFeed.channel ? database.getContent(null) : null,
  ]);
  if (
    webMcpInteraction && beforeItem &&
    !isUnpublishedStatus(beforeItem.status)
  ) {
    return localizedError(request, "errors.feed.webmcpNoLongerUnpublished", 409);
  }
  await database.putContent(updatedFeed, async (statements) => {
    const events = [];
    if (updatedItemId && updatedFeed.item) {
      const after = webhookItemObject(
        updatedFeed.item as unknown as Record<string, unknown>,
      );
      const mutation = !beforeItem
        ? "created"
        : updatedFeed.item.status === STATUSES.DELETED
        ? "deleted"
        : "updated";
      events.push(...contentMutationWebhookInputs({
        ...(mutation === "deleted"
          ? {before: webhookItemObject(beforeItem ?? after)}
          : {
              after,
              ...(beforeItem ? {before: webhookItemObject(beforeItem)} : {}),
            }),
        id: updatedItemId,
        kind: "item",
        mutation,
      }));
    }
    if (updatedFeed.channel) {
      const before = webhookChannelSnapshot(
        (beforeChannelContent?.channel ?? {}) as Record<string, unknown>,
      );
      const after = webhookChannelSnapshot(
        updatedFeed.channel as Record<string, unknown>,
      );
      const changedFields = changedWebhookFields(before, after);
      if (changedFields.length > 0) {
        events.push({
          changedFields,
          object: after,
          subjectId: "primary",
          subjectType: "channel" as const,
          type: "channel.updated" as const,
        });
      }
    }
    await commitMutationWithWebhookEvents(
      runtimeEnv,
      request,
      statements,
      events,
      {origin: webMcpInteraction ? "webmcp" : "dashboard"},
    );
  });
  // novel-cms audit trail: the dashboard editor persists through putContent
  // directly (it does not call updateItem), so the seam must record here too.
  // A brand-new item (no beforeItem) is recorded as a checkpoint so version 1
  // stays recoverable; an existing item follows the normal checkpoint cadence.
  if (updatedItemId && updatedFeed.item) {
    const afterItem = await database.getItemById(updatedItemId);
    if (afterItem) {
      await recordContentChange(database.FEED_DB as unknown as AuditDb, {
        action: "edit",
        actorType: "author",
        after: afterItem as Record<string, unknown>,
        before: (beforeItem ?? {}) as Record<string, unknown>,
        itemId: updatedItemId,
        // Review off: the audit trail still records the change, but no pending
        // version opens and the pin-to-approved gate never runs — a save takes
        // effect immediately (openReview === false skips exactly those).
        openReview: reviewWasEnabled ? undefined : false,
      });
    }
  }
  // Turning review OFF is the moment queued changes die: every still-pending
  // version is rejected (its content never reaches the live body — the pin
  // already held it back), and the reject actions land in the audit trail.
  // Turning it ON needs no migration: saves start opening versions again.
  const contentReviewUpdate = updatedFeed.settings?.contentReview;
  if (contentReviewUpdate && reviewWasEnabled &&
    contentReviewUpdate.enabled !== true
  ) {
    const reviewDb = runtimeEnv.FEED_DB as unknown as AuditDb;
    const pending = await listPendingChapters(reviewDb);
    for (const chapter of pending) {
      await rejectChapterVersions(reviewDb, chapter.itemId, null);
    }
  }
  // B20: the client only sends `deleteImageUrls` (cover art) when deleting an
  // item, so the body's embedded images and the main media attachment used to
  // stay in R2 forever. Gather them from the pre-delete snapshot; every URL is
  // re-validated by managedMediaObjectKey before any delete happens.
  const deletedItemMedia = updatedFeed.item?.status === STATUSES.DELETED
    ? itemMediaUrls(beforeItem)
    : [];
  scheduleBestEffortMediaDeletion(
    mediaBucket(runtimeEnv),
    [...deleteImageUrls, ...deletedItemMedia],
    schedule,
  );
  return jsonResponse({});
}

export const POST: APIRoute = async ({locals, request}) => {
  // Deleting a chapter is its own permission (§8.1 `content:chapter:delete`),
  // separate from editing one. The delete arrives as a POST whose item status is
  // DELETED, so the code depends on the body. Peek through a clone: the handler
  // below still has to read the original request body.
  const preview = await request.clone().json().catch(() => null) as
    | {item?: {id?: unknown; status?: unknown}}
    | null;
  const isDeleting = preview?.item?.status === STATUSES.DELETED;
  // B3: a save that carries no item id is a *create* (the new/import pages guard
  // with `content:chapter:create`), so it must be authorised with the create
  // code rather than update — otherwise a user who can open the new-chapter page
  // is 403'd on save. A save with an id is an update; a delete status is a delete.
  const isCreating = preview?.item?.id == null;
  const guardCode = isDeleting
    ? PERMISSION_CODES.CONTENT_CHAPTER_DELETE
    : isCreating
      ? PERMISSION_CODES.CONTENT_CHAPTER_CREATE
      : PERMISSION_CODES.CONTENT_CHAPTER_UPDATE;
  const guard = await requireRbac(
    locals,
    guardCode,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  return updateAdminFeed(request, env, waitUntil, cache);
};
