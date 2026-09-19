import type {FeedContent} from "../../types";

import {z} from "zod";

import {AppError} from "@/shared/errors";
import FeedDb from "@/server/feed/FeedDb";
import {createFeedCrud} from "@/server/feed/feed";
import {recordItemEdit, type AuditDb} from "@/server/feed/extContentAudit";
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
  await recordItemEdit(
    database.FEED_DB as unknown as AuditDb,
    before,
    next,
    {actorType: "author"},
  );
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
  feedCrud: ReturnType<typeof createFeedCrud>;
}> {
  const database = new FeedDb(runtimeEnv, request);
  const board = await listVolumeBoard(
    database.FEED_DB as unknown as VolumeDb,
    bookId,
  );
  if (!board.book) throw new AppError(VOLUME_ERRORS.bookMissing, 404);
  const chapterIds = new Set<string>();
  for (const group of board.groups) {
    for (const chapter of group.chapters) chapterIds.add(chapter.id);
  }
  const content = await database.getContent(null) as unknown as FeedContent;
  return {
    chapterIds,
    database,
    feedCrud: createFeedCrud(content, database, request),
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
  const {chapterIds, database, feedCrud} = await openBook(
    request,
    runtimeEnv,
    bookId,
  );
  let updated = 0;
  for (const itemId of itemIds) {
    if (!chapterIds.has(itemId)) continue;
    const ok = await patchChapter(
      database,
      feedCrud,
      itemId,
      {volume: volume.trim()},
      () => true,
    );
    if (ok) updated += 1;
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
  const {chapterIds, database, feedCrud} = await openBook(
    request,
    runtimeEnv,
    bookId,
  );
  // Merging two volumes by renaming one onto the other is easy to trigger by
  // accident and hard to undo, so it is rejected; use "file under volume"
  // instead when a merge is really wanted.
  const board = await listVolumeBoard(
    database.FEED_DB as unknown as VolumeDb,
    bookId,
  );
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
