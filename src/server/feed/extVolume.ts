import {STATUSES} from "@/shared/Constants";
import {TCM_CHAPTER_ORDER_SQL} from "@/server/tcm/ordering";
import {fetchSectionsByParents} from "@/server/feed/tcmSections";
import {
  UNFILED_VOLUME_KEY,
  type VolumeBookOption,
  type VolumeEntry,
  type VolumeEntryList,
  type VolumeList,
  type VolumeSummary,
} from "@/shared/ExtVolume";

export {UNFILED_VOLUME_KEY};

export type {
  VolumeBookOption,
  VolumeEntry,
  VolumeEntryList,
  VolumeList,
  VolumeSummary,
};

/** Minimal D1-shaped database port. Real D1 satisfies this structurally, and a
 *  fake implements it for unit tests — same pattern as extCategory. */
export interface VolumeDbRunResult {
  success: boolean;
}

export interface VolumeDbAllResult {
  results: Record<string, unknown>[];
}

export interface VolumeDbPreparedStatement {
  bind(...values: unknown[]): VolumeDbPreparedStatement;
  run(): Promise<VolumeDbRunResult>;
  all(): Promise<VolumeDbAllResult>;
  first(): Promise<Record<string, unknown> | null>;
}

export interface VolumeDb {
  prepare(query: string): VolumeDbPreparedStatement;
}

function safeParseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** Read an item/channel `data` blob's `_microfeed` pocket as a plain object. */
function pocketOf(data: Record<string, unknown>): Record<string, unknown> {
  const pocket = data._microfeed;
  return pocket && typeof pocket === "object"
    ? pocket as Record<string, unknown>
    : {};
}

/** The display title of a channel or item row, with the board's fallbacks. */
function titleOf(data: Record<string, unknown>, fallback: string): string {
  return typeof data.title === "string" && data.title ? data.title : fallback;
}

/** Point-read the book row the board header shows; null when it does not exist. */
async function readVolumeBook(
  db: VolumeDb,
  bookId: string,
): Promise<VolumeBookOption | null> {
  const bookRow = await db.prepare(
    "SELECT id, data FROM channels WHERE id = ?",
  ).bind(bookId).first();
  if (bookRow == null) return null;
  return {id: asText(bookRow.id), title: titleOf(safeParseJson(bookRow.data), "未命名作品")};
}

/** True when the book row exists.
 *
 *  写入入口用它来做「这本书还在不在」的判定：一次 `channels` 主键点查，只读 id 一列。
 *  只看行在不在，被软删的书照样可以整理——卷列表本身也不按 status 过滤书目行，
 *  只有书目选择器（{@link listVolumeBooks}）会隐藏已删除的频道。写入路径不需要卷列表，
 *  所以这里不能借用 {@link listBookVolumes}——那要把这本书的每一行条目在覆盖索引上
 *  步进一遍（《素问》8,812 个索引条目），而归卷 3 条只需要 6 行守卫点查加 3 行整行读取。 */
export async function volumeBookExists(
  db: VolumeDb,
  bookId: string,
): Promise<boolean> {
  const row = await db.prepare(
    "SELECT id FROM channels WHERE id = ?",
  ).bind(bookId).first();
  return row != null;
}

/** True when the book is TCM-structured: its entries carry `tcm_kind`, so the
 *  volumes are `chapter` entities rather than `_microfeed.volume` tags.
 *
 *  一次 `LIMIT 1` 探测：`items_book_kind (book_id, tcm_kind)` 上最多步进 1 个索引条目。 */
export async function isTcmBook(db: VolumeDb, bookId: string): Promise<boolean> {
  const probe = await db.prepare(
    "SELECT 1 AS one FROM items WHERE book_id = ? AND tcm_kind IS NOT NULL AND status != ? LIMIT 1",
  ).bind(bookId, STATUSES.DELETED).first();
  return probe != null;
}

/** The volume board's book list — 卷 only, no entry rows.
 *
 *  This is what clicking a book loads: one scan of the book's volume structure
 *  plus per-volume counts, instead of every entry the book has. The entries of
 *  one volume are fetched separately when the admin expands it.
 *
 *  The two kinds of book differ in where a volume lives, and the difference
 *  stays here: each row carries the key the client has to send back, so the UI
 *  never has to tell a TCM chapter id from a volume tag. */
export async function listBookVolumes(
  db: VolumeDb,
  bookId: string,
): Promise<VolumeList> {
  const book = await readVolumeBook(db, bookId);
  if (book == null) return {book, tcm: false, volumes: []};
  if (await isTcmBook(db, bookId)) {
    return {book, tcm: true, volumes: await listTcmVolumes(db, bookId)};
  }
  return {book, tcm: false, volumes: await listTagVolumes(db, bookId)};
}

/** The entries of one volume — the request the board makes when it expands.
 *
 *  Opening a volume reads that volume and nothing else: a TCM volume is one
 *  primary-key point read to validate the key plus one indexed read of its
 *  children (`items_section_order`，最大的一卷 306 条 = 306 个索引条目加 306 次回表，
 *  约 612 行、47,478 字节，见 ADR-0027 的代价表)，and the
 *  response lists every entry it has (no paging — a page control over data the
 *  server already read saves nothing).
 *
 *  The key must belong to this book. A stale bookmark or a hand-edited URL is
 *  answered with an empty list and **no** entry read, so a request can never
 *  walk into another book's contents. */
export async function listVolumeEntries(
  db: VolumeDb,
  bookId: string,
  volumeKey: string,
): Promise<VolumeEntryList> {
  if (!volumeKey) return {entries: [], name: "", tcm: false, unknown: true};
  if (await isTcmBook(db, bookId)) {
    return listTcmVolumeEntries(db, bookId, volumeKey);
  }
  return listTagVolumeEntries(db, bookId, volumeKey);
}

/** The ids one volume contains — the set a write handler is allowed to change.
 *
 *  写入入口（改名、卷序）要按卷选出目标 id，而不是把整本书读回来再在 JavaScript
 *  里分组。代价与读路径同级：TCM 典籍以 `tcm_kind` + `tcm_parent_id` 命中
 *  `items_tcm_kind_parent`，只选 id 一列；未归类桶复用条目列表里那条 `NOT EXISTS`
 *  口径。标签书的卷名在 `data` 里，没有可用索引，这条查询把整本书按 `items_book_id`
 *  步进一遍——与 {@link listTagVolumeEntries} 同代价，是本项目对标签书既有的口径。
 *
 *  `tcm` 由调用方给出：写入入口的 `openBook` 已经探过一次书形，这里再探一次就是
 *  白多一趟往返。
 *
 *  返回的顺序不重要：写入只按集合改动，所以这条查询不带 `ORDER BY`——卷内序是读
 *  路径（{@link listTcmVolumeEntries}）才需要给出的东西。
 *
 *  归卷 3 条的守卫读取：改动前 5,928 行（整本书读两遍的推得口径），改动后 2×3 = 6 行。 */
export async function listVolumeEntryIds(
  db: VolumeDb,
  bookId: string,
  volumeKey: string,
  tcm: boolean,
): Promise<string[]> {
  if (!volumeKey) return [];
  if (tcm) return listTcmVolumeEntryIds(db, bookId, volumeKey);
  const result = await db.prepare(
    "SELECT id FROM items " +
      "WHERE book_id = ? AND status != ? " +
      "AND COALESCE(json_extract(data, '$._microfeed.volume'), '') = ?",
  ).bind(
    bookId,
    STATUSES.DELETED,
    volumeKey === UNFILED_VOLUME_KEY ? "" : volumeKey,
  ).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  return rows.map((row) => asText(row.id)).filter((id) => id !== "");
}

/** Ids under a TCM volume; an unknown or deleted chapter key selects nothing. */
async function listTcmVolumeEntryIds(
  db: VolumeDb,
  bookId: string,
  volumeKey: string,
): Promise<string[]> {
  if (volumeKey === UNFILED_VOLUME_KEY) {
    const result = await db.prepare(
      "SELECT id FROM items " +
        "WHERE book_id = ? AND tcm_kind = 'section' AND status != ? " +
        "AND NOT EXISTS (SELECT 1 FROM items c WHERE c.book_id = ? " +
        "AND c.tcm_kind = 'chapter' AND c.id = items.tcm_parent_id)",
    ).bind(bookId, STATUSES.DELETED, bookId).all();
    const rows = Array.isArray(result.results) ? result.results : [];
    return rows.map((row) => asText(row.id)).filter((id) => id !== "");
  }

  const chapterRow = await db.prepare(
    "SELECT id, book_id, status, tcm_kind FROM items WHERE id = ?",
  ).bind(volumeKey).first();
  if (chapterRow == null
    || asText(chapterRow.tcm_kind) !== "chapter"
    || asText(chapterRow.book_id) !== bookId
    || Number(chapterRow.status) === STATUSES.DELETED) {
    return [];
  }
  // 卷内的一切条目都要选出来：中药/名词书把 `yao`/`term` 行挂在根篇章下，它们同样是
  // 这一卷的行，只按 `section` 选会把它们漏在写入之外。`fang` 是独立目录、篇章自身是
  // 卷名那一行，两者都不归这一条写路径改（与守卫 `membershipGuard` 同一口径）。
  const result = await db.prepare(
    "SELECT id FROM items " +
      "WHERE tcm_parent_id = ? AND book_id = ? " +
      "AND tcm_kind NOT IN ('chapter', 'fang') AND status != ?",
  ).bind(volumeKey, bookId, STATUSES.DELETED).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  return rows.map((row) => asText(row.id)).filter((id) => id !== "");
}

/** Volumes of a TCM book: the `chapter` rows, counted through their children. */
async function listTcmVolumes(
  db: VolumeDb,
  bookId: string,
): Promise<VolumeSummary[]> {
  // 篇章查询刻意不带 `status != ?`：条文挂在被软删的篇章下时不算未归类（卷列表
  // 的口径），所以被软删篇章的 id 要留在合法分组键集合里，它自身不作为卷展示。
  const chapterResult = await db.prepare(
    "SELECT id, status, data FROM items " +
      "WHERE book_id = ? AND tcm_kind = 'chapter' " +
      // 与 App GetBookChapter / 书页目录同一排序键（netcore 字符串序，见 ordering.ts）
      "ORDER BY " + TCM_CHAPTER_ORDER_SQL,
  ).bind(bookId).all();
  const chapterRows = Array.isArray(chapterResult.results)
    ? chapterResult.results
    : [];

  // 逐卷条数走覆盖索引：`book_id` / `tcm_kind` / `status` / `tcm_parent_id` 四个
  // 被引用的列都在 0116 重建后的 `items_book_kind` 里，这一条扫描一次不回表，同时
  // 给出三个数：每卷条数、按父项分组的条文数、以及分组键不在本书篇章 id 集合里
  // 的那些条文组（未归类桶）。一条扫描把这三项一起给出，所以点书不需要为确认「有没有
  // 孤儿」再读一遍本书的每个 section。
  // `tcm_kind != 'chapter'` 把篇章自身挡在分组之外——篇章行的 `tcm_parent_id` 是空的。
  // 未归类只数 `section`：方剂（`fang`）也带着本书的 `book_id`，但它是独立的方剂
  // 目录、不属于卷/章树，混进来会凭空造出一个几百条的「未归类」桶。
  const countResult = await db.prepare(
    "SELECT tcm_parent_id AS parent, tcm_kind AS kind, COUNT(*) AS total FROM items " +
      "WHERE book_id = ? AND tcm_kind != 'chapter' AND status != ? " +
      "GROUP BY tcm_parent_id, tcm_kind",
  ).bind(bookId, STATUSES.DELETED).all();
  const countRows = Array.isArray(countResult.results)
    ? countResult.results
    : [];
  const counts = new Map<string, number>();
  const sectionCounts = new Map<string, number>();
  for (const row of countRows) {
    const parent = asText(row.parent);
    const kind = asText(row.kind);
    const total = Number(row.total ?? 0);
    counts.set(parent, (counts.get(parent) ?? 0) + total);
    if (kind === "section") {
      sectionCounts.set(parent, (sectionCounts.get(parent) ?? 0) + total);
    }
  }

  const chapterIds = new Set<string>();
  const volumes: VolumeSummary[] = [];
  for (const row of chapterRows) {
    const id = asText(row.id);
    chapterIds.add(id);
    if (Number(row.status) === STATUSES.DELETED) continue;
    const data = safeParseJson(row.data);
    volumes.push({
      chapterCount: counts.get(id) ?? 0,
      key: id,
      name: titleOf(data, "未命名篇章"),
      order: asNumber(pocketOf(data).section) ?? 0,
    });
  }

  // 未归类桶恒在最后：它读起来是「还没归档」，而不是第 0 卷。分组键为空或指向
  // 本书之外的那些条文落在这里；被软删的篇章仍是合法分组键（见上面的篇章查询），
  // 所以挂在被删篇章下的条文不会被算成未归类，与卷列表的计数口径一致。
  const unfiled = [...sectionCounts.entries()]
    .filter(([parent]) => !chapterIds.has(parent))
    .reduce((sum, [, total]) => sum + total, 0);
  if (unfiled > 0) {
    volumes.push({
      chapterCount: unfiled,
      key: UNFILED_VOLUME_KEY,
      name: "",
      order: null,
    });
  }
  return volumes;
}

/** 把一行条目（`id / status / data / pub_date`）映射成看板展开时的那一行。 */
function toVolumeEntry(row: Record<string, unknown>, index: number): VolumeEntry {
  const data = safeParseJson(row.data);
  return {
    datePublished: asText(row.pub_date),
    id: asText(row.id),
    index: index + 1,
    status: Number(row.status ?? 0),
    title: titleOf(data, "未命名章节"),
    volumeOrder: asNumber(pocketOf(data).volumeOrder),
  };
}

/** Entries of a TCM volume: the rows filed under that chapter. */
async function listTcmVolumeEntries(
  db: VolumeDb,
  bookId: string,
  volumeKey: string,
): Promise<VolumeEntryList> {
  if (volumeKey === UNFILED_VOLUME_KEY) {
    // 未归类桶只在确有孤儿时出现在卷列表里（条数为 0 就不渲染这一行），所以这条扫描
    // 只在异常态发生：`items_book_kind (book_id, tcm_kind, ...)` 步进本书的 section 行，
    // 再用主键点查确认父项是不是本书篇章。父键为 NULL 的行同样算孤儿（`NOT EXISTS` 对
    // NULL 恒为真）；子查询刻意不带 status 条件，被软删的篇章照样算父项，它下面的条文
    // 不落进这里——与卷列表的计数口径同一条。
    const orphanResult = await db.prepare(
      "SELECT id, status, data, pub_date FROM items " +
        "WHERE book_id = ? AND tcm_kind = 'section' AND status != ? " +
        "AND NOT EXISTS (SELECT 1 FROM items c WHERE c.book_id = ? " +
        "AND c.tcm_kind = 'chapter' AND c.id = items.tcm_parent_id) " +
        "ORDER BY COALESCE(json_extract(data, '$._microfeed.receiptNo'), " +
        "json_extract(data, '$._microfeed.no')), id",
    ).bind(bookId, STATUSES.DELETED, bookId).all();
    const orphanRows = Array.isArray(orphanResult.results)
      ? orphanResult.results
      : [];
    return {
      entries: orphanRows.map(toVolumeEntry),
      name: "",
      tcm: true,
      unknown: false,
    };
  }

  // 主键点查：卷键必须真的是这本书的一行篇章。被软删的篇章不作为卷渲染，这里同样
  // 按「不存在」处理，因此手填或过期的地址不会读走任何条文，也不会读到别的书。
  const chapterRow = await db.prepare(
    "SELECT id, book_id, status, tcm_kind, data FROM items WHERE id = ?",
  ).bind(volumeKey).first();
  if (chapterRow == null
    || asText(chapterRow.tcm_kind) !== "chapter"
    || asText(chapterRow.book_id) !== bookId
    || Number(chapterRow.status) === STATUSES.DELETED) {
    return {entries: [], name: "", tcm: true, unknown: true};
  }
  const chapterId = asText(chapterRow.id);
  // 卷内序与书页目录同源：`fetchSectionsByParents` 的排序键以 `tcm_parent_id` 打头，
  // 命中 `items_section_order`，计划里没有临时 B-tree。
  const sectionsByParent = await fetchSectionsByParents(db, [chapterId]);
  return {
    entries: (sectionsByParent.get(chapterId) ?? []).map(toVolumeEntry),
    name: titleOf(safeParseJson(chapterRow.data), "未命名篇章"),
    tcm: true,
    unknown: false,
  };
}

/** One tagged chapter, kept only as long as it takes to bucket the volumes. */
interface TagVolumeRow {
  chapterNo: number;
  datePublished: string;
  id: string;
  volume: string;
  volumeOrder: number | null;
}

/** Volumes of a tag-based book: the distinct `_microfeed.volume` labels.
 *
 *  A tag lives inside `data`, so there is no index that can count per volume —
 *  this branch reads the whole book's rows (four columns, no body text) and
 *  groups them in memory. That is the accepted cost for this kind of book: the
 *  local database has no tag-based books at all (every item carries `tcm_kind`),
 *  so the branch is not on any hot path, and giving it a derived column plus an
 *  index would be a migration for a shape nobody has. */
async function listTagVolumes(
  db: VolumeDb,
  bookId: string,
): Promise<VolumeSummary[]> {
  const result = await db.prepare(
    "SELECT id, status, data, pub_date FROM items WHERE book_id = ? AND status != ?",
  ).bind(bookId, STATUSES.DELETED).all();
  const rows = Array.isArray(result.results) ? result.results : [];

  const chapters: TagVolumeRow[] = [];
  for (const row of rows) {
    const data = safeParseJson(row.data);
    const microfeed = pocketOf(data);
    chapters.push({
      chapterNo: asNumber(microfeed.chapterNo) ?? 0,
      datePublished: asText(row.pub_date),
      id: asText(row.id),
      volume: asText(microfeed.volume).trim(),
      volumeOrder: asNumber(microfeed.volumeOrder),
    });
  }

  chapters.sort((a, b) => {
    if (a.chapterNo !== b.chapterNo) return a.chapterNo - b.chapterNo;
    if (a.datePublished !== b.datePublished) {
      return a.datePublished < b.datePublished ? -1 : 1;
    }
    return a.id < b.id ? -1 : 1;
  });

  const buckets = new Map<string, TagVolumeRow[]>();
  for (const chapter of chapters) {
    const bucket = buckets.get(chapter.volume);
    if (bucket) bucket.push(chapter);
    else buckets.set(chapter.volume, [chapter]);
  }

  const groups = [...buckets.entries()].map(([name, list]) => ({
    chapterCount: list.length,
    first: list[0],
    key: name === "" ? UNFILED_VOLUME_KEY : name,
    name,
    order: list
      .map((chapter) => chapter.volumeOrder)
      .find((value): value is number => value != null) ?? null,
  }));

  groups.sort((a, b) => {
    // The unfiled bucket (empty name) is always last.
    if (!a.name !== !b.name) return a.name ? -1 : 1;
    const aKey = a.order ?? a.first?.chapterNo ?? 0;
    const bKey = b.order ?? b.first?.chapterNo ?? 0;
    if (aKey !== bKey) return aKey - bKey;
    // `chapterNo` restarts in every volume (第一卷 第1章 and 第二卷 第1章 are
    // both 1), so volumes usually tie here. Fall back to the publish order of
    // each volume's first chapter — the same globally monotonic order the
    // catalog uses. Sorting the names instead would order them by pinyin
    // (第二卷 "er" before 第一卷 "yi"), which reads backward to a reader.
    const aDate = a.first?.datePublished ?? "";
    const bDate = b.first?.datePublished ?? "";
    if (aDate !== bDate) return aDate < bDate ? -1 : 1;
    return (a.first?.id ?? "").localeCompare(b.first?.id ?? "");
  });

  return groups.map((group) => ({
    chapterCount: group.chapterCount,
    key: group.key,
    name: group.name,
    order: group.order,
  }));
}

/** Entries of a tag-based volume: the book's rows whose `_microfeed.volume`
 *  equals the key (the unfiled bucket is the empty label).
 *
 *  A tag lives inside `data`, so no index can narrow this to one volume: the
 *  read steps the whole book through `items_book_id` and keeps four narrow
 *  columns. Accepted cost, same reasoning as {@link listTagVolumes} — the local
 *  database has no tag-based book at all, so this branch is not a hot path.
 *  Ordering stays in JavaScript with the volume list's comparator
 *  (`chapterNo` → 发布时间 → id), so an expanded volume lists its chapters in
 *  the same order its volume row was derived from. */
async function listTagVolumeEntries(
  db: VolumeDb,
  bookId: string,
  volumeKey: string,
): Promise<VolumeEntryList> {
  const unfiled = volumeKey === UNFILED_VOLUME_KEY;
  const result = await db.prepare(
    "SELECT id, status, data, pub_date FROM items " +
      "WHERE book_id = ? AND status != ? " +
      "AND COALESCE(json_extract(data, '$._microfeed.volume'), '') = ?",
  ).bind(bookId, STATUSES.DELETED, unfiled ? "" : volumeKey).all();
  const rows = Array.isArray(result.results) ? result.results : [];

  const sortable = rows.map((row) => {
    const pocket = pocketOf(safeParseJson(row.data));
    return {
      chapterNo: asNumber(pocket.chapterNo) ?? 0,
      datePublished: asText(row.pub_date),
      id: asText(row.id),
      row,
    };
  });
  sortable.sort((a, b) => {
    if (a.chapterNo !== b.chapterNo) return a.chapterNo - b.chapterNo;
    if (a.datePublished !== b.datePublished) {
      return a.datePublished < b.datePublished ? -1 : 1;
    }
    return a.id < b.id ? -1 : 1;
  });

  const entries = sortable.map((entry, index) => toVolumeEntry(entry.row, index));
  return {
    entries,
    name: unfiled ? "" : volumeKey,
    tcm: false,
    // 标签书的每个卷都是从这些行里分出来的，所以匹配不到任何行的键一定是失效的键。
    unknown: !unfiled && entries.length === 0,
  };
}

/** Books (channels) offered in the volume board's book picker.
 *
 *  Unlike the public helpers this does **not** filter to published books: an
 *  admin must be able to structure a book that is still a draft. Deleted
 *  channels are the only ones hidden. TCM container channels (方剂/本草/名词,
 *  marked by `_microfeed.tcmContainer`) are not books — their entries belong to
 *  the real books through `_microfeed.sourceBookId` — so they are filtered out
 *  here instead of showing up as a book titled "方剂". */
export async function listVolumeBooks(
  db: VolumeDb,
): Promise<VolumeBookOption[]> {
  const result = await db.prepare(
    "SELECT id, data, status FROM channels ORDER BY created_at ASC",
  ).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  const books: VolumeBookOption[] = [];
  for (const row of rows) {
    if (Number(row.status) === STATUSES.DELETED) continue;
    const data = safeParseJson(row.data);
    const microfeed = data._microfeed && typeof data._microfeed === "object"
      ? data._microfeed as Record<string, unknown>
      : {};
    if (microfeed.tcmContainer != null) continue;
    books.push({
      id: asText(row.id),
      title: typeof data.title === "string" && data.title
        ? data.title
        : "未命名作品",
    });
  }
  return books;
}
