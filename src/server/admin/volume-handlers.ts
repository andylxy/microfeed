import {cache} from "cloudflare:workers";

import type {FeedContent} from "../../types";

import {z} from "zod";

import {AppError} from "@/shared/errors";
import {STATUSES} from "@/shared/Constants";
import FeedDb from "@/server/feed/FeedDb";
import {createFeedCrud} from "@/server/feed/feed";
import {recordContentChange} from "@/server/feed/extContentReview";
import type {AuditDb} from "@/server/feed/extContentAudit";
import {
  listVolumeBoard,
  listVolumeBooks,
  type VolumeDb,
} from "@/server/feed/extVolume";

/**
 * Dashboard-side operations for the novel-cms volume board.
 *
 * A volume is not an entity — it is the `_microfeed.volume` tag carried by each
 * chapter — so every operation here is a batch of item writes plus an audit
 * row. The grouping/ordering rules live in `extVolume` (pure); this module only
 * wires them to a request, the way the category handlers do for genres.
 */

const bookIdField = z.string().min(1).max(11);
const itemIdField = z.string().min(1).max(11);
const volumeNameField = z.string().max(200);

const assignSchema = z.object({
  bookId: bookIdField,
  itemIds: z.array(itemIdField).min(1).max(500),
  volume: volumeNameField,
});

const renameSchema = z.object({
  bookId: bookIdField,
  from: volumeNameField,
  to: volumeNameField,
});

const reorderSchema = z.object({
  bookId: bookIdField,
  updates: z.array(z.object({
    chapterNo: z.number().int().min(0).max(1000000),
    id: itemIdField,
  })).min(1).max(500),
});

const volumeOrderSchema = z.object({
  bookId: bookIdField,
  orders: z.array(z.object({
    order: z.number().int().min(0).max(100000),
    volume: volumeNameField,
  })).min(1).max(200),
});

export const VOLUME_ERRORS = {
  bookMissing: "errors.volumes.bookMissing",
  invalidInput: "errors.volumes.invalidInput",
  volumeExists: "errors.volumes.volumeExists",
} as const;

type ItemRecord = Record<string, unknown>;

/** Read the `_microfeed` pocket of an item as a plain object. */
function microfeedOf(item: ItemRecord): ItemRecord {
  const pocket = item._microfeed;
  return pocket && typeof pocket === "object"
    ? {...(pocket as ItemRecord)}
    : {};
}

/** An 11-character item id, matching the ids the rest of the app mints. */
function newItemId(): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(11);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const b of bytes) id += alphabet[b % alphabet.length];
  return id;
}

/**
 * In a TCM book a volume *is* a `chapter` (篇章) row — the board renders those
 * rows as volumes and files each `section` under one through `tcm_parent_id`.
 * So volume names have to be resolved back to the row that carries them.
 */
async function findTcmChapterId(
  db: VolumeDb,
  bookId: string,
  title: string,
): Promise<string | null> {
  const row = await db.prepare(
    "SELECT id FROM items WHERE book_id = ? AND tcm_kind = 'chapter' " +
      "AND status != ? AND json_extract(data, '$.title') = ? LIMIT 1",
  ).bind(bookId, STATUSES.DELETED, title).first();
  return row && typeof row.id === "string" ? row.id : null;
}

/** Resolve the chapter backing `title`, creating it when the volume is new —
 *  that is how "new volume" works for a TCM book. */
async function ensureTcmChapter(
  db: VolumeDb,
  bookId: string,
  title: string,
): Promise<string> {
  const existing = await findTcmChapterId(db, bookId, title);
  if (existing) return existing;
  const maxRow = await db.prepare(
    "SELECT MAX(json_extract(data, '$._microfeed.section')) AS m " +
      "FROM items WHERE book_id = ? AND tcm_kind = 'chapter'",
  ).bind(bookId).first();
  const nextSection = Number(maxRow?.m ?? 0) + 1;
  const now = new Date().toISOString();
  const id = newItemId();
  await db.prepare(
    "INSERT INTO items " +
      "(id,status,data,pub_date,created_at,updated_at,content_text," +
      "review_status,book_id,tcm_kind) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).bind(
    id,
    STATUSES.PUBLISHED,
    JSON.stringify({title, _microfeed: {bookId, section: nextSection}}),
    now,
    now,
    now,
    "",
    "approved",
    bookId,
    "chapter",
  ).run();
  return id;
}

/** Re-file one TCM section under a chapter (null sends it to the unfiled
 *  bucket) and keep its display tag in step. `tcm_parent_id` is a column while
 *  `_microfeed.volume` lives inside `data`, so both are written here in one
 *  statement instead of through the tag-only `_microfeed` patch — otherwise the
 *  section would move on the board while the item editor still shows the old
 *  volume. */
async function setTcmChapter(
  db: VolumeDb,
  itemId: string,
  parentId: string | null,
  volume: string,
): Promise<void> {
  await db.prepare(
    "UPDATE items SET tcm_parent_id = ?, " +
      "data = json_set(data, '$._microfeed.volume', ?) WHERE id = ?",
  ).bind(parentId, volume, itemId).run();
}

/** Rewrite one chapter's `_microfeed` keys, saving through FeedCrud so the
 *  `items.review_status` mirror stays in sync, and record the edit. */
async function patchChapter(
  database: FeedDb,
  feedCrud: ReturnType<typeof createFeedCrud>,
  itemId: string,
  patch: ItemRecord,
  allow: (microfeed: ItemRecord) => boolean,
): Promise<boolean> {
  const existing = await database.getItemById(itemId);
  if (!existing) return false;
  const before = existing as unknown as ItemRecord;
  const microfeed = microfeedOf(before);
  if (!allow(microfeed)) return false;
  const next: ItemRecord = {
    ...before,
    id: itemId,
    _microfeed: {...microfeed, ...patch},
  };
  await feedCrud.saveInternalItem(next);
  await recordContentChange(database.FEED_DB as unknown as AuditDb, {
    action: "edit",
    actorType: "author",
    after: next,
    before,
    itemId,
  });
  return true;
}

/** Shared setup: one FeedDb + FeedCrud per request, plus the book's chapter
 *  ids so a request can never reach into another book's chapters. */
async function openBook(
  request: Request,
  runtimeEnv: Env,
  bookId: string,
): Promise<{
  chapterIds: Set<string>;
  database: FeedDb;
  db: VolumeDb;
  feedCrud: ReturnType<typeof createFeedCrud>;
  tcm: boolean;
}> {
  const database = new FeedDb(runtimeEnv, request, cache);
  const db = database.FEED_DB as unknown as VolumeDb;
  const board = await listVolumeBoard(db, bookId);
  if (!board.book) throw new AppError(VOLUME_ERRORS.bookMissing, 404);
  // TCM books keep their structure in `tcm_kind`/`tcm_parent_id`, so their
  // writes have to be translated (see findTcmChapterId) instead of stopping at
  // the `_microfeed.volume` tag the board ignores.
  const probe = await db.prepare(
    "SELECT 1 AS one FROM items WHERE book_id = ? " +
      "AND tcm_kind IS NOT NULL LIMIT 1",
  ).bind(bookId).first();
  const chapterIds = new Set<string>();
  for (const group of board.groups) {
    for (const chapter of group.chapters) chapterIds.add(chapter.id);
  }
  const content = await database.getContent(null) as unknown as FeedContent;
  return {
    chapterIds,
    database,
    db,
    feedCrud: createFeedCrud(content, database, request),
    tcm: probe != null,
  };
}

export async function listVolumeBooksHandler(db: VolumeDb) {
  return listVolumeBooks(db);
}

export async function listVolumeBoardHandler(
  db: VolumeDb,
  bookId: string,
) {
  if (!bookId) throw new AppError(VOLUME_ERRORS.invalidInput, 400);
  return listVolumeBoard(db, bookId);
}

/** File the given chapters under a volume. An empty `volume` sends them back
 *  to the unfiled bucket. */
export async function assignChaptersHandler(
  request: Request,
  runtimeEnv: Env,
  body: unknown,
): Promise<{updated: number}> {
  const parsed = assignSchema.safeParse(body);
  if (!parsed.success) throw new AppError(VOLUME_ERRORS.invalidInput, 400);
  const {bookId, itemIds, volume} = parsed.data;
  const {chapterIds, database, db, feedCrud, tcm} = await openBook(
    request,
    runtimeEnv,
    bookId,
  );
  const target = volume.trim();
  // In a TCM book a volume is a 篇章 row, so resolve (or create) it once and
  // point every filed section at it — otherwise the move would only rewrite an
  // ignored tag and the section would stay where it was.
  const tcmChapterId = tcm && target
    ? await ensureTcmChapter(db, bookId, target)
    : null;
  let updated = 0;
  for (const itemId of itemIds) {
    if (!chapterIds.has(itemId)) continue;
    const ok = await patchChapter(
      database,
      feedCrud,
      itemId,
      {volume: target},
      () => true,
    );
    if (!ok) continue;
    updated += 1;
    if (tcm) {
      await setTcmChapter(db, itemId, target ? tcmChapterId : null, target);
    }
  }
  return {updated};
}

/** Rename a volume by rewriting the tag on every chapter that carries it.
 *  `from: ""` files the whole unfiled bucket in one go. */
export async function renameVolumeHandler(
  request: Request,
  runtimeEnv: Env,
  body: unknown,
): Promise<{updated: number}> {
  const parsed = renameSchema.safeParse(body);
  if (!parsed.success) throw new AppError(VOLUME_ERRORS.invalidInput, 400);
  const {bookId, from, to} = parsed.data;
  const target = to.trim();
  if (!target) throw new AppError(VOLUME_ERRORS.invalidInput, 400);
  const {chapterIds, database, db, feedCrud, tcm} = await openBook(
    request,
    runtimeEnv,
    bookId,
  );
  // Merging two volumes by renaming one onto the other is easy to trigger by
  // accident and hard to undo, so it is rejected; use "file under volume"
  // instead when a merge is really wanted.
  const board = await listVolumeBoard(db, bookId);
  if (target !== from.trim() && board.volumeNames.includes(target)) {
    throw new AppError(VOLUME_ERRORS.volumeExists, 409);
  }
  let updated = 0;
  for (const itemId of chapterIds) {
    const ok = await patchChapter(
      database,
      feedCrud,
      itemId,
      {volume: target},
      (microfeed) => String(microfeed.volume ?? "").trim() === from.trim(),
    );
    if (ok) updated += 1;
  }
  // A TCM volume's name is the 篇章 row's own title — the board renders that
  // title as the group name — so renaming the volume means renaming the row,
  // not just the tags its sections carry.
  if (tcm) {
    const chapterId = await findTcmChapterId(db, bookId, from.trim());
    if (chapterId) {
      await db.prepare(
        "UPDATE items SET data = json_set(data, '$.title', ?) WHERE id = ?",
      ).bind(target, chapterId).run();
      // Every section filed under it carries the volume name for display.
      await db.prepare(
        "UPDATE items SET data = json_set(data, '$._microfeed.volume', ?) " +
          "WHERE tcm_parent_id = ?",
      ).bind(target, chapterId).run();
    }
  }
  return {updated};
}

/** Rewrite `chapterNo` on the given chapters — this is what moves a chapter
 *  inside its volume and across volumes. */
export async function reorderChaptersHandler(
  request: Request,
  runtimeEnv: Env,
  body: unknown,
): Promise<{updated: number}> {
  const parsed = reorderSchema.safeParse(body);
  if (!parsed.success) throw new AppError(VOLUME_ERRORS.invalidInput, 400);
  const {bookId, updates} = parsed.data;
  const {chapterIds, database, feedCrud} = await openBook(
    request,
    runtimeEnv,
    bookId,
  );
  let updated = 0;
  for (const update of updates) {
    if (!chapterIds.has(update.id)) continue;
    const ok = await patchChapter(
      database,
      feedCrud,
      update.id,
      {chapterNo: update.chapterNo},
      () => true,
    );
    if (ok) updated += 1;
  }
  return {updated};
}

/** Give a volume an explicit position. The order is stored as a tag on the
 *  volume's chapters, so it needs no table of its own. */
export async function setVolumeOrderHandler(
  request: Request,
  runtimeEnv: Env,
  body: unknown,
): Promise<{updated: number}> {
  const parsed = volumeOrderSchema.safeParse(body);
  if (!parsed.success) throw new AppError(VOLUME_ERRORS.invalidInput, 400);
  const {bookId, orders} = parsed.data;
  const {chapterIds, database, feedCrud} = await openBook(
    request,
    runtimeEnv,
    bookId,
  );
  const board = await listVolumeBoard(
    database.FEED_DB as unknown as VolumeDb,
    bookId,
  );
  const byVolume = new Map<string, string[]>();
  for (const group of board.groups) {
    byVolume.set(
      group.name,
      group.chapters.map((chapter) => chapter.id),
    );
  }
  let updated = 0;
  for (const entry of orders) {
    const ids = byVolume.get(entry.volume) ?? [];
    for (const itemId of ids) {
      if (!chapterIds.has(itemId)) continue;
      const ok = await patchChapter(
        database,
        feedCrud,
        itemId,
        {volumeOrder: entry.order},
        () => true,
      );
      if (ok) updated += 1;
    }
  }
  return {updated};
}
