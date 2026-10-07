import {cache} from "cloudflare:workers";

import type {FeedContent} from "../../types";

import {z} from "zod";

import {AppError} from "@/shared/errors";
import {STATUSES} from "@/shared/Constants";
import FeedDb from "@/server/feed/FeedDb";
import {createFeedCrud} from "@/server/feed/feed";
import {planContentChange} from "@/server/feed/extContentReview";
import type {AuditDb} from "@/server/feed/extContentAudit";
import type {DatabaseMutationCommit} from "@/server/mutation";
import {
  listVolumeBoard,
  listVolumeBooks,
  type VolumeDb,
} from "@/server/feed/extVolume";

/**
 * 小说后台「卷」看板的操作入口。
 *
 * 卷不是实体——它是每个章节携带的 `_microfeed.volume` 标签——所以这里的每个操作
 * 都是一批 item 写入加一条审计记录。分组与排序规则放在 `extVolume`（纯函数）；
 * 本模块只把它们接到请求上，和分类处理器处理体裁的做法一样。
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

/** 一个待改的章节：要并入的 `_microfeed` 键，以及判断这个章节是否允许被改的守卫。 */
interface ChapterPatch {
  itemId: string;
  patch: ItemRecord;
  allow: (microfeed: ItemRecord) => boolean;
}

/** 把条目的 `_microfeed` 口袋读成普通对象。 */
function microfeedOf(item: ItemRecord): ItemRecord {
  const pocket = item._microfeed;
  return pocket && typeof pocket === "object"
    ? {...(pocket as ItemRecord)}
    : {};
}

/** 11 位条目 id，与全站其它地方生成的 id 一致。 */
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
 * 中医书里「卷」就是一行 `chapter`（篇章）——看板把这些行当成卷来渲染，并把每条
 * `section`（条文）通过 `tcm_parent_id` 归到其中一行下。所以卷名要能反查回承载它的那行。
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

/** 反查承载 `title` 的篇章；卷是新建的就创建它——中医书「新建卷」就是这么做的。 */
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

/** 构造一条「把中医条文改挂到某个篇章下」的 UPDATE 语句（传 null 表示移到未归类桶）。
 *  一条语句同时写 `tcm_parent_id`（真实列）与 `_microfeed.volume`（在 `data` 里），
 *  让看板与条目编辑器看到同一个卷名。调用方把多条这样的语句合进一次 batch。 */
function tcmChapterStatement(
  db: VolumeDb,
  itemId: string,
  parentId: string | null,
  volume: string,
): D1PreparedStatement {
  return db.prepare(
    "UPDATE items SET tcm_parent_id = ?, " +
      "data = json_set(data, '$._microfeed.volume', ?) WHERE id = ?",
  ).bind(parentId, volume, itemId) as unknown as D1PreparedStatement;
}

/**
 * 批量修改章节，把所有 item 写入与审计语句合并进**一次** `db.batch()`。
 *
 * 每个章节的读取保留（处理后的条目形状来自 `getItemById`），但 N 次 upsert 收敛成
 * 一次往返；审计语句与 item 写入同批，所以「章节已改但无审计」的部分失败窗口不再
 * 存在。返回真正发生变化的 id（存在且通过守卫），顺序与输入一致。
 */
async function patchChapters(
  database: FeedDb,
  feedCrud: ReturnType<typeof createFeedCrud>,
  targets: readonly ChapterPatch[],
): Promise<string[]> {
  const statements: D1PreparedStatement[] = [];
  const collect: DatabaseMutationCommit<Record<string, unknown>> =
    async (batch) => {
      statements.push(...batch);
    };
  const changed: Array<{
    itemId: string;
    before: ItemRecord;
    after: ItemRecord;
  }> = [];
  for (const target of targets) {
    const existing = await database.getItemById(target.itemId);
    if (!existing) continue;
    const before = existing as unknown as ItemRecord;
    const microfeed = microfeedOf(before);
    if (!target.allow(microfeed)) continue;
    const next: ItemRecord = {
      ...before,
      id: target.itemId,
      _microfeed: {...microfeed, ...target.patch},
    };
    await feedCrud.saveInternalItem(next, collect);
    changed.push({itemId: target.itemId, before, after: next});
  }
  // 审计语句与 item 写入进同一个批次：要么都持久化、要么都回滚。
  for (const entry of changed) {
    const plan = await planContentChange(
      database.FEED_DB as unknown as AuditDb,
      {
        action: "edit",
        actorType: "author",
        after: entry.after,
        before: entry.before,
        itemId: entry.itemId,
      },
    );
    statements.push(...(plan.statements as unknown as D1PreparedStatement[]));
  }
  if (statements.length > 0) await database.FEED_DB.batch(statements);
  return changed.map((entry) => entry.itemId);
}

/** 每个请求一份 FeedDb 与 FeedCrud，外加本书的章节 id 集合，这样请求永远碰不到别的书的章节。 */
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
  // 中医书的结构放在 `tcm_kind` / `tcm_parent_id` 里，所以它们的写入需要翻译
  // （见 findTcmChapterId），而不能止步于看板不认的 `_microfeed.volume` 标签。
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

/** 把给定章节归到某个卷下。`volume` 为空表示退回未归类桶。 */
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
  // 中医书里卷是一行篇章，所以只反查（或创建）一次，再让每条归档的条文指向它——
  // 否则这次移动只会改写一个被忽略的标签，条文留在原地不动。
  const tcmChapterId = tcm && target
    ? await ensureTcmChapter(db, bookId, target)
    : null;
  const targets: ChapterPatch[] = itemIds
    .filter((itemId) => chapterIds.has(itemId))
    .map((itemId) => ({itemId, patch: {volume: target}, allow: () => true}));
  const applied = await patchChapters(database, feedCrud, targets);
  if (tcm && applied.length > 0) {
    const parentId = target ? tcmChapterId : null;
    await database.FEED_DB.batch(
      applied.map((itemId) =>
        tcmChapterStatement(db, itemId, parentId, target)),
    );
  }
  return {updated: applied.length};
}

/** 通过改写每个携带该卷名的章节的标签来重命名卷。`from: ""` 表示一次性把整个未归类桶归档。 */
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
  // 把一个卷改名到另一个卷上就等于合并，误触容易、撤销困难，所以直接拒绝；确实想合并
  // 时改用「归到某个卷下」。
  const board = await listVolumeBoard(db, bookId);
  if (target !== from.trim() && board.volumeNames.includes(target)) {
    throw new AppError(VOLUME_ERRORS.volumeExists, 409);
  }
  const targets: ChapterPatch[] = [...chapterIds].map((itemId) => ({
    itemId,
    patch: {volume: target},
    allow: (microfeed) => String(microfeed.volume ?? "").trim() === from.trim(),
  }));
  const applied = await patchChapters(database, feedCrud, targets);
  // 中医卷的名字就是那行篇章自己的标题——看板把这个标题当成组名渲染——所以重命名卷
  // 就是重命名那行，其下条文携带的标签也一并跟随。
  if (tcm) {
    const chapterId = await findTcmChapterId(db, bookId, from.trim());
    if (chapterId) {
      // 条文的过滤条件必须以 `tcm_kind` 打头，写入才能命中
      // `items_tcm_kind_parent (tcm_kind, tcm_parent_id)`，不必全表扫描；
      // 归到某个篇章下的每一行都是 `section`。
      await database.FEED_DB.batch([
        db.prepare(
          "UPDATE items SET data = json_set(data, '$.title', ?) WHERE id = ?",
        ).bind(target, chapterId),
        db.prepare(
          "UPDATE items SET data = json_set(data, '$._microfeed.volume', ?) " +
            "WHERE tcm_kind = 'section' AND tcm_parent_id = ?",
        ).bind(target, chapterId),
      ]);
    }
  }
  return {updated: applied.length};
}

/** 改写给定章节的 `chapterNo`——这正是章节在卷内移动、以及跨卷移动的方式。 */
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
  const targets: ChapterPatch[] = updates
    .filter((update) => chapterIds.has(update.id))
    .map((update) => ({
      itemId: update.id,
      patch: {chapterNo: update.chapterNo},
      allow: () => true,
    }));
  const applied = await patchChapters(database, feedCrud, targets);
  return {updated: applied.length};
}

/** 给卷一个明确的位置。顺序存成卷内章节的标签，所以不需要单独的表。 */
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
  const targets: ChapterPatch[] = [];
  for (const entry of orders) {
    const ids = byVolume.get(entry.volume) ?? [];
    for (const itemId of ids) {
      if (!chapterIds.has(itemId)) continue;
      targets.push({
        itemId,
        patch: {volumeOrder: entry.order},
        allow: () => true,
      });
    }
  }
  const applied = await patchChapters(database, feedCrud, targets);
  return {updated: applied.length};
}
