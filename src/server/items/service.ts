import {ITEM_STATUSES_STRINGS_DICT, STATUSES} from "@/shared/Constants";
import type FeedCrudManager from "@/server/feed/FeedCrudManager";
import type FeedDb from "@/server/feed/FeedDb";
import {recordContentChange} from "@/server/feed/extContentReview";
import type {AuditDb} from "@/server/feed/extContentAudit";
import {PUBLIC_CACHE_TAGS} from "@/server/cache/public-cache";
import type {DatabaseMutationCommit} from "@/server/mutation";

type ItemInput = Record<string, any>;

function statusValue(value: unknown, fallback: number): number {
  if (typeof value === "number" && Object.values(STATUSES).includes(value)) {
    return value;
  }
  return (ITEM_STATUSES_STRINGS_DICT as Readonly<Record<string, number>>)[
    String(value ?? "")
  ] ?? fallback;
}

function normalizedInput(
  input: ItemInput,
  fallbackStatus: number,
  defaultPublishedAt?: number,
): ItemInput {
  const normalized = {...input};
  normalized.status = statusValue(input.status, fallbackStatus);
  if (input.date_published_ms !== undefined) {
    normalized.date_published_ms = input.date_published_ms;
  } else if (typeof input.date_published === "string") {
    const timestamp = Date.parse(input.date_published);
    if (!Number.isNaN(timestamp)) normalized.date_published_ms = timestamp;
  } else if (defaultPublishedAt !== undefined) {
    normalized.date_published_ms = defaultPublishedAt;
  }
  return normalized;
}

export async function createItem(
  feedCrud: FeedCrudManager,
  input: ItemInput,
  reservedId?: string,
  commit?: DatabaseMutationCommit<Record<string, unknown>>,
): Promise<string> {
  const {id: _ignored, ...fields} = input;
  const id = await feedCrud.upsertItem(normalizedInput(
    {...fields, ...(reservedId ? {id: reservedId} : {})},
    STATUSES.PUBLISHED,
    Date.now(),
  ), commit);
  // novel-cms audit trail: the creation is recorded as a checkpoint so the very
  // first version is always recoverable. rebuildItemVersion needs a preceding
  // checkpoint, so without this, versions 1..K-1 were unrecoverable. The audit
  // insert runs after the upsert, mirroring how updateItem records its edit.
  const auditDb = feedCrud.feedDb?.FEED_DB as unknown as AuditDb | undefined;
  if (auditDb) {
    const created = await feedCrud.feedDb.getItemById(id);
    if (created) {
      await recordContentChange(auditDb, {
        action: "edit",
        actorType: "author",
        after: created as Record<string, unknown>,
        before: {},
        itemId: id,
      });
    }
  }
  return id;
}

export async function updateItem(
  database: FeedDb,
  feedCrud: FeedCrudManager,
  id: string,
  input: ItemInput,
  commit?: DatabaseMutationCommit<Record<string, unknown>>,
): Promise<ItemInput | null> {
  const existing = await database.getItemById(id);
  if (!existing) return null;
  const normalized = normalizedInput(input, existing.status);
  const patch = feedCrud._publicToInternalSchemaForItem(normalized);
  const finalizesDraftPublicationDate =
    input.date_published !== undefined ||
    input.date_published_ms !== undefined ||
    (
      Object.hasOwn(input, "status") &&
      normalized.status === STATUSES.PUBLISHED
    );
  const item = {
    ...existing,
    ...patch,
    ...(finalizesDraftPublicationDate
      ? {pubDateIsDraftDefault: false}
      : {}),
    guid: input.guid ?? existing.guid ?? id,
    id,
    pubDateMs: patch.pubDateMs ?? existing.pubDateMs,
    status: patch.status ?? existing.status,
  };
  await feedCrud.saveInternalItem(item, commit);
  // novel-cms audit trail. This is the only call site in the core: the diff
  // model and the checkpoint cadence live in extContentAudit, and an edit that
  // changes nothing records nothing.
  const change = await recordContentChange(
    database.FEED_DB as unknown as AuditDb,
    {
      action: "edit",
      after: item as Record<string, unknown>,
      before: existing as Record<string, unknown>,
      itemId: id,
    },
  );

  // The save above purges the public cache, but the review gate then writes the
  // approved content back over what was just saved. Purge again, or a request
  // landing in between renders the unconfirmed change — exactly what the gate
  // exists to prevent.
  if (change) {
    await database.purgePublicCacheTags([
      PUBLIC_CACHE_TAGS.PUBLIC,
      PUBLIC_CACHE_TAGS.ITEMS,
      PUBLIC_CACHE_TAGS.CHANNEL_PRIMARY,
      PUBLIC_CACHE_TAGS.item(id),
    ]);
  }
  return item;
}

export async function deleteItem(
  database: FeedDb,
  feedCrud: FeedCrudManager,
  id: string,
  commit?: DatabaseMutationCommit<Record<string, unknown>>,
): Promise<boolean> {
  const existing = await database.getItemById(id);
  if (!existing) return false;
  const deleted = {...existing, id, status: STATUSES.DELETED};
  await feedCrud.saveInternalItem(deleted, commit);
  // novel-cms audit trail: a deletion is a content change, so it has to leave a
  // row — otherwise the trail silently loses the fact that a chapter was ever
  // removed. It is recorded as `delete` (status -> deleted), which is not the
  // same as `takedown` (unpublished but still present). No checkpoint: there is
  // no reason to make the deleted state a replay anchor.
  await recordContentChange(database.FEED_DB as unknown as AuditDb, {
    action: "delete",
    actorType: "author",
    after: deleted as Record<string, unknown>,
    before: existing as Record<string, unknown>,
    itemId: id,
  });
  return true;
}
