import {cache} from "cloudflare:workers";

import type {FeedContent} from "../../types";

import {z} from "zod";

import {AppError} from "@/shared/errors";
import {STATUSES} from "@/shared/Constants";
import {PUBLIC_CACHE_TAGS} from "@/server/cache/public-cache";
import FeedDb from "@/server/feed/FeedDb";
import {createFeedCrud} from "@/server/feed/feed";
import {planContentChange} from "@/server/feed/extContentReview";
import type {AuditDb} from "@/server/feed/extContentAudit";
import type {DatabaseMutationCommit} from "@/server/mutation";
import {
  isTcmBook,
  listBookVolumes,
  listVolumeBooks,
  listVolumeEntries,
  listVolumeEntryIds,
  UNFILED_VOLUME_KEY,
  type VolumeDb,
  volumeBookExists,
} from "@/server/feed/extVolume";

/**
 * 小说后台「卷」看板的操作入口。
 *
 * 卷不是实体——它是每个章节携带的 `_microfeed.volume` 标签——所以这里的每个操作
 * 都是一批 item 写入加一条审计记录。分组与排序规则放在 `extVolume`（纯函数）；
 * 本模块只把它们接到请求上，和分类处理器处理体裁的做法一样。
 *
 * 写入前不做整本读取：每个提交进来的 id 各读两下——一次整行（`getItemById`，
 * 重建条目与审计快照要用完整 `data`），一次只读结构列的守卫点查（`book_id` 等，
 * 走主键）。所以一次归卷 12 条读 24 行，而不是先把整本书读回来。
 *
 * 归卷 3 条的守卫读取，改动前 5,928 行（整本书读两遍的推得口径），改动后 6 行。
 * 整块看板读取入口随这条改动一起删除，按需读取的取舍见 ADR-0027。
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
  /** 守卫条件：只读结构列的主键点查，不属于这本书（或不是该改的那一类）的行直接跳过。
   *  有了它，写入前不再需要把整本书读回来构造 id 集合。 */
  guard: {bind: unknown[]; where: string};
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
 * 每个章节各读两下：一次整行（重建条目与审计快照需要完整 `data`），一次只读结构列的
 * 守卫点查（主键）。所以这次操作的行读是 `2 × 提交的 id 数`，与这本书有多大无关；
 * N 次 upsert 收敛成一次往返，审计语句与 item 写入同批，所以「章节已改但无审计」的
 * 部分失败窗口不再存在。返回真正发生变化的 id（存在、通过守卫），顺序与输入一致。
 */
async function patchChapters(
  db: VolumeDb,
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
    // 守卫：主键点查，只问结构列。不属于这本书、或不是该改的那一类的行在这里跳过，
    // 写入别人的条目在这个入口就没有路径。
    const allowed = await db.prepare(
      `SELECT id FROM items WHERE id = ? AND ${target.guard.where}`,
    ).bind(target.itemId, ...target.guard.bind).first();
    if (!allowed) continue;
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

/**
 * 卷板写入后清理公开缓存。
 *
 * 这四个写入处理器都走裸 `FEED_DB.batch()`（含上面的 `patchChapters`），绕开了
 * `FeedDb.putContent` 里那条 `_purgePublicCacheTags`——所以卷名 / 卷序 / 归档
 * 变化改写了 `_microfeed.volume`、`title`、`tcm_parent_id`，**书页与章页的 CDN
 * 缓存却不会被失效**。边缘 TTL 现在按 `PUBLIC_CACHE_EDGE_CONTROL` 是 24h，漏清理
 * 的实际后果就是「改一次卷名，读者最长 24 小时看着旧目录分组」，这也是把 TTL
 * 从 300s 拉到 24h 之前必须先补上的那个口子。
 *
 * 标签挑书页同款（`publicCacheTagsForPath` 对 `isBookScopedPath` 挂 ITEMS + PAGES），
 * 再逐条加被改写条目的 `mf:item:{id}`——章页 `isItemPath` 自己带的就是这个。
 * 刻意不 purge `mf:public`：首页 / 分类页 / feed 只呈现书名、封面与 ADR-0012
 * 物化后的章节数，这三项都不随卷名卷序变。
 *
 * 走 `database.purgePublicCacheTags` 而不是直接调 `purgePublicCache`，是为了沿
 * 用实例上那三个开关（非 preview、有 ACCOUNT_ID、传了 purger）——构造 `FeedDb`
 * 时已经算好，本地开发与无账号配置下自动跳过。
 */
async function purgeVolumeBoardCache(
  database: FeedDb,
  changedItemIds: Iterable<string>,
): Promise<void> {
  const tags = new Set<string>([
    PUBLIC_CACHE_TAGS.ITEMS,
    PUBLIC_CACHE_TAGS.PAGES,
  ]);
  for (const itemId of changedItemIds) {
    tags.add(PUBLIC_CACHE_TAGS.item(itemId));
  }
  await database.purgePublicCacheTags([...tags]);
}

/** 每个写入请求一份 FeedDb 与 FeedCrud，外加这本书的书形判定。
 *
 *  这里只读三下：`channels` 主键点查（这本书还在不在）、一次 `items_book_kind` 上的
 *  `LIMIT 1` 探测（篇章/条文结构，还是卷标签结构）、`getContent(null)`（站点设置与主
 *  频道，`items` 一行都不读）。合法 id 集合不再在这里攒出来——它由每个提交进来的 id
 *  各自的主键点查决定（见 `patchChapters` 的 guard），所以归卷 N 条的行读是 2N，
 *  与这本书有多少条无关。 */
async function openBook(
  request: Request,
  runtimeEnv: Env,
  bookId: string,
): Promise<{
  database: FeedDb;
  db: VolumeDb;
  feedCrud: ReturnType<typeof createFeedCrud>;
  tcm: boolean;
}> {
  const database = new FeedDb(runtimeEnv, request, cache);
  const db = database.FEED_DB as unknown as VolumeDb;
  if (!(await volumeBookExists(db, bookId))) {
    throw new AppError(VOLUME_ERRORS.bookMissing, 404);
  }
  // 中医书的结构放在 `tcm_kind` / `tcm_parent_id` 里，所以它们的写入需要翻译
  // （见 findTcmChapterId），而不能止步于卷列表不认的 `_microfeed.volume` 标签。
  const tcm = await isTcmBook(db, bookId);
  const content = await database.getContent(null) as unknown as FeedContent;
  return {
    database,
    db,
    feedCrud: createFeedCrud(content, database, request),
    tcm,
  };
}

/** 归卷与调序的守卫：只允许改动这本书自己、且属于卷/章树的那些行。
 *
 *  中医典籍放开到 `section` / `yao` / `term`：中药书与名词书把它们的行挂在根篇章下，
 *  卷列表把这些行当成这一卷的条目渲染，守卫若只认 `section` 就会在改名与卷序时把它们
 *  漏在写入之外。`chapter` 自身（卷名就是它的标题，由 rename 单独改写）与独立目录
 *  `fang` 不在这条路径上，与卷列表的计数口径同一条。
 *
 *  这条 `where` 与 `id = ?` 一起拼进主键点查，所以一次守卫只读一行。 */
function membershipGuard(tcm: boolean, bookId: string): ChapterPatch["guard"] {
  return tcm
    ? {
        bind: [bookId, STATUSES.DELETED],
        where: "book_id = ? AND tcm_kind NOT IN ('chapter', 'fang') AND status != ?",
      }
    : {bind: [bookId, STATUSES.DELETED], where: "book_id = ? AND status != ?"};
}

export async function listVolumeBooksHandler(db: VolumeDb) {
  return listVolumeBooks(db);
}

/** 点书时加载的卷列表：本书的卷与每卷条数，不含任何条目行。 */
export async function listBookVolumesHandler(
  db: VolumeDb,
  bookId: string,
) {
  if (!bookId) throw new AppError(VOLUME_ERRORS.invalidInput, 400);
  return listBookVolumes(db, bookId);
}

/** 点卷时加载的条目列表：这一卷的全部条目，一次请求读全，不翻页。
 *
 *  卷键必须属于 `bookId`；不属于时 `listVolumeEntries` 返回空列表，且不会为别的书
 *  读任何一行，所以过期地址与手改地址都读不到别人的内容。 */
export async function listVolumeEntriesHandler(
  db: VolumeDb,
  bookId: string,
  volumeKey: string,
) {
  if (!bookId || !volumeKey) throw new AppError(VOLUME_ERRORS.invalidInput, 400);
  return listVolumeEntries(db, bookId, volumeKey);
}

/** 卷名 → 卷键。后台的写入载荷带的是卷名（管理员看到的那行文字），卷列表回给前端的
 *  是键：中医典籍的键是那行篇章的 id，标签书的键就是卷名本身，空名对应未归类桶。
 *  名字在这本书里对不上任何卷时返回空串，调用方据此什么都不改。 */
async function volumeKeyOfName(
  db: VolumeDb,
  bookId: string,
  name: string,
  tcm: boolean,
): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) return UNFILED_VOLUME_KEY;
  if (!tcm) return trimmed;
  return (await findTcmChapterId(db, bookId, trimmed)) ?? "";
}

/** 这本书里是否已经有一个卷叫这个名字。中医典籍反查一行篇章（在 `items_book_kind`
 *  上最多步进本书的篇章行数）；标签书按卷名条件选出带该标签的 id——卷名在 `data`
 *  里，标签书没有可用的索引，这与卷列表同一口径。 */
async function volumeNameTaken(
  db: VolumeDb,
  bookId: string,
  name: string,
  tcm: boolean,
): Promise<boolean> {
  if (tcm) return (await findTcmChapterId(db, bookId, name)) != null;
  return (await listVolumeEntryIds(db, bookId, name, false)).length > 0;
}

/** 本书全部篇章的「标题 → id」映射。设置卷序的载荷会把当前列出的每个卷都带进
 *  `orders`，逐卷反查就是每卷一次「步进本书全部篇章行」（81 卷要步 6,561 行）；
 *  读一次篇章列表（81 行，标题由 `json_extract` 就地取出）建映射代替。 */
async function tcmChapterIdByTitle(
  db: VolumeDb,
  bookId: string,
): Promise<Map<string, string>> {
  const result = await db.prepare(
    "SELECT id, json_extract(data, '$.title') AS title FROM items " +
      "WHERE book_id = ? AND tcm_kind = 'chapter' AND status != ?",
  ).bind(bookId, STATUSES.DELETED).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  const byTitle = new Map<string, string>();
  for (const row of rows) {
    const title = typeof row.title === "string" ? row.title : "";
    const id = typeof row.id === "string" ? row.id : "";
    if (title && id) byTitle.set(title, id);
  }
  return byTitle;
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
  const {database, db, feedCrud, tcm} = await openBook(
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
  const guard = membershipGuard(tcm, bookId);
  const targets: ChapterPatch[] = itemIds.map((itemId) => ({
    allow: () => true,
    guard,
    itemId,
    patch: {volume: target},
  }));
  const applied = await patchChapters(db, database, feedCrud, targets);
  if (tcm && applied.length > 0) {
    const parentId = target ? tcmChapterId : null;
    await database.FEED_DB.batch(
      applied.map((itemId) =>
        tcmChapterStatement(db, itemId, parentId, target)),
    );
  }
  await purgeVolumeBoardCache(database, applied);
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
  const {database, db, feedCrud, tcm} = await openBook(
    request,
    runtimeEnv,
    bookId,
  );
  const source = from.trim();
  // 把一个卷改名到另一个卷上就等于合并，误触容易、撤销困难，所以直接拒绝；确实想合并
  // 时改用「归到某个卷下」。
  if (target !== source && await volumeNameTaken(db, bookId, target, tcm)) {
    throw new AppError(VOLUME_ERRORS.volumeExists, 409);
  }
  // 只改这一卷里的条目：先按卷条件选出它的 id，再逐条点查守卫与整行。
  const sourceKey = await volumeKeyOfName(db, bookId, source, tcm);
  const sourceIds = await listVolumeEntryIds(db, bookId, sourceKey, tcm);
  const targets: ChapterPatch[] = sourceIds.map((itemId) => ({
    allow: (microfeed: ItemRecord) =>
      String(microfeed.volume ?? "").trim() === source,
    guard: membershipGuard(tcm, bookId),
    itemId,
    patch: {volume: target},
  }));
  const applied = await patchChapters(db, database, feedCrud, targets);
  // 中医卷的名字就是那行篇章自己的标题——卷列表把这个标题当成卷名渲染——所以重命名卷
  // 就是重命名那行，其下条文携带的标签也一并跟随。
  let renamedTcmChapterId: string | null = null;
  if (tcm) {
    const chapterId = await findTcmChapterId(db, bookId, source);
    if (chapterId) {
      renamedTcmChapterId = chapterId;
      // 条文的过滤条件必须以 `tcm_kind` 打头，写入才能命中
      // `items_tcm_kind_parent (tcm_kind, tcm_parent_id)`，不必全表扫描。这一条只随
      // `section`：卷内其余的行（`yao` / `term`）由上面的逐条写入跟随，条件是它们
      // 确实携带旧卷名——把这条批量改写放开到 `NOT IN` 会让首列失去等值条件，索引
      // 用不上，反而变成全表扫描。
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
  await purgeVolumeBoardCache(
    database,
    renamedTcmChapterId ? [...applied, renamedTcmChapterId] : applied,
  );
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
  const {database, db, feedCrud, tcm} = await openBook(
    request,
    runtimeEnv,
    bookId,
  );
  const guard = membershipGuard(tcm, bookId);
  const targets: ChapterPatch[] = updates.map((update) => ({
    allow: () => true,
    guard,
    itemId: update.id,
    patch: {chapterNo: update.chapterNo},
  }));
  const applied = await patchChapters(db, database, feedCrud, targets);
  await purgeVolumeBoardCache(database, applied);
  return {updated: applied.length};
}

/** 给卷一个明确的位置。顺序存成卷内章节的标签，所以不需要单独的表。
 *
 *  这笔写入的规模由载荷决定，不由这本书的规模决定：前端的上下移动会把当前列出的每个卷
 *  都带进 `orders`，所以一次保存会重写它点到的那些卷的全部条目。未被点到的卷一行都不读。 */
export async function setVolumeOrderHandler(
  request: Request,
  runtimeEnv: Env,
  body: unknown,
): Promise<{updated: number}> {
  const parsed = volumeOrderSchema.safeParse(body);
  if (!parsed.success) throw new AppError(VOLUME_ERRORS.invalidInput, 400);
  const {bookId, orders} = parsed.data;
  const {database, db, feedCrud, tcm} = await openBook(
    request,
    runtimeEnv,
    bookId,
  );
  const chapterIds = tcm ? await tcmChapterIdByTitle(db, bookId) : null;
  const guard = membershipGuard(tcm, bookId);
  const targets: ChapterPatch[] = [];
  for (const entry of orders) {
    const name = entry.volume.trim();
    // 空卷名就是未归类桶；中医典籍的卷名要换成那行篇章的 id，对不上就跳过这一项。
    const volumeKey = name
      ? (tcm ? (chapterIds?.get(name) ?? "") : name)
      : UNFILED_VOLUME_KEY;
    if (!volumeKey) continue;
    for (const itemId of await listVolumeEntryIds(db, bookId, volumeKey, tcm)) {
      targets.push({
        allow: () => true,
        guard,
        itemId,
        patch: {volumeOrder: entry.order},
      });
    }
  }
  const applied = await patchChapters(db, database, feedCrud, targets);
  await purgeVolumeBoardCache(database, applied);
  return {updated: applied.length};
}
