import {ITEM_STATUSES_STRINGS_DICT, STATUSES} from "@/shared/Constants";
import type FeedCrudManager from "@/server/feed/FeedCrudManager";
import type FeedDb from "@/server/feed/FeedDb";
import {planContentChange} from "@/server/feed/extContentReview";
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
  const itemData = normalizedInput(
    {...fields, ...(reservedId ? {id: reservedId} : {})},
    STATUSES.PUBLISHED,
    Date.now(),
  );
  const statements: D1PreparedStatement[] = [];
  const collect: DatabaseMutationCommit<Record<string, unknown>> = async (batch) => {
    statements.push(...batch);
  };
  const auditDb = feedCrud.feedDb?.FEED_DB as unknown as AuditDb | undefined;
  const id = await feedCrud.upsertItem(itemData, auditDb ? collect : commit);
  if (auditDb) {
    // `upsertItem` 已把 item 转成内部 schema 并写到 `feedContent.item`（description /
    // contentText 等均已派生），这就是「写入后会存入数据库的那一行」。作为审计 after 必须用这个
    // 内部 schema 后的对象（即 upsertItem 写入的行），不要传原始输入 itemData——否则 review 版本快照会带上
    // `content_html` 与调用方塞进来的 `content_text`，回拨闸门（planPinToLastApproved）
    // 据此写回时缺 `description`，content_text 被派生成空串（原实现是写完再 getItemById 读回，
    // 这里改成复用同一对象以保留「item 写入 + 审计同批」的原子性）。
    const created = feedCrud.feedContent.item as Record<string, unknown>;
    const plan = await planContentChange(auditDb, {
      action: "edit",
      actorType: "author",
      after: created,
      before: {},
      itemId: id,
    });
    statements.push(...(plan.statements as unknown as D1PreparedStatement[]));
    if (statements.length > 0) {
      if (commit) await commit(statements, created);
      else await (feedCrud.feedDb.FEED_DB).batch(statements);
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
  const statements: D1PreparedStatement[] = [];
  const collect: DatabaseMutationCommit<Record<string, unknown>> = async (batch) => {
    statements.push(...batch);
  };
  const auditDb = database.FEED_DB as unknown as AuditDb;
  await feedCrud.saveInternalItem(item, collect);
  const plan = await planContentChange(auditDb, {
    action: "edit",
    after: item as Record<string, unknown>,
    before: existing as Record<string, unknown>,
    itemId: id,
  });
  statements.push(...(plan.statements as unknown as D1PreparedStatement[]));
  if (statements.length > 0) {
    if (commit) await commit(statements, item);
    else await database.FEED_DB.batch(statements);
  }

  // The review gate writes the approved content back over what was just saved.
  // Purge the public cache so a request landing in between does not render the
  // unconfirmed change — exactly what the gate exists to prevent.
  if (plan.review) {
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
  const statements: D1PreparedStatement[] = [];
  const collect: DatabaseMutationCommit<Record<string, unknown>> = async (batch) => {
    statements.push(...batch);
  };
  const auditDb = database.FEED_DB as unknown as AuditDb;
  await feedCrud.saveInternalItem(deleted, collect);
  const plan = await planContentChange(auditDb, {
    action: "delete",
    actorType: "author",
    after: deleted as Record<string, unknown>,
    before: existing as Record<string, unknown>,
    itemId: id,
  });
  statements.push(...(plan.statements as unknown as D1PreparedStatement[]));
  if (statements.length > 0) {
    if (commit) await commit(statements, deleted);
    else await database.FEED_DB.batch(statements);
  }
  return true;
}
