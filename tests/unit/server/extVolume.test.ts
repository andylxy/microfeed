import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {
  listBookVolumes,
  listVolumeBooks,
  listVolumeEntries,
  listVolumeEntryIds,
  UNFILED_VOLUME_KEY,
  volumeBookExists,
  type VolumeDb,
  type VolumeDbAllResult,
  type VolumeDbPreparedStatement,
} from "@/server/feed/extVolume";

type SqlInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;

class SqliteStatement implements VolumeDbPreparedStatement {
  private readonly statement: ReturnType<DatabaseSync["prepare"]>;
  private values: SqlInputValue[] = [];

  constructor(database: DatabaseSync, query: string) {
    this.statement = database.prepare(query);
  }

  bind(...values: unknown[]): VolumeDbPreparedStatement {
    this.values = values as SqlInputValue[];
    return this;
  }

  async all(): Promise<VolumeDbAllResult> {
    return {
      results: this.statement.all(...this.values) as Record<string, unknown>[],
    };
  }

  async first(): Promise<Record<string, unknown> | null> {
    return (this.statement.get(...this.values) as Record<string, unknown> | undefined)
      ?? null;
  }

  async run(): Promise<{success: boolean}> {
    this.statement.run(...this.values);
    return {success: true};
  }
}

class SqliteVolumeDb implements VolumeDb {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): VolumeDbPreparedStatement {
    return new SqliteStatement(this.database, query);
  }
}

function chapter(
  id: string,
  bookId: string,
  volume: string,
  chapterNo: number,
  extra: {
    microfeed?: Record<string, unknown>;
    pubDate?: string;
    status?: number;
  } = {},
): [string, number, string, string, string] {
  return [
    id,
    extra.status ?? 1,
    JSON.stringify({
      title: id,
      _microfeed: {bookId, chapterNo, volume, ...(extra.microfeed ?? {})},
    }),
    extra.pubDate ?? "2026-01-01T00:00:00Z",
    // B18: `items.book_id` is the denormalized, indexable copy of
    // `_microfeed.bookId` (migration 0056) and the board now queries it, so the
    // fixture carries both like the real row does.
    bookId,
  ];
}

/** 书籍状态字典的最小种子：删除态取 code 3（迁移 0142 的系统行）。 */
const BOOK_STATUS_SEED = `
    CREATE TABLE ext_book_status (
      code INTEGER PRIMARY KEY,
      name_zh TEXT NOT NULL,
      name_en TEXT NOT NULL,
      form_selectable INTEGER NOT NULL DEFAULT 1,
      public_visible INTEGER NOT NULL DEFAULT 0,
      admin_list_hidden INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      sort INTEGER NOT NULL DEFAULT 0,
      color_fg TEXT,
      color_bg TEXT
    );
    INSERT INTO ext_book_status
      (code, name_zh, name_en, form_selectable, public_visible, admin_list_hidden, is_system, sort) VALUES
      (1, '显示', 'Visible', 1, 1, 0, 1, 100),
      (2, '隐藏', 'Hidden', 1, 0, 0, 1, 200),
      (3, '已删除', 'Deleted', 0, 0, 1, 1, 300);
`;

function databaseWithBook(chapters: Array<[string, number, string, string, string]>): VolumeDb {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE channels (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      status INTEGER NOT NULL,
      created_at INTEGER
    );
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      status INTEGER NOT NULL,
      pub_date TEXT,
      book_id TEXT,
      tcm_kind TEXT,
      tcm_parent_id TEXT
    );
    INSERT INTO channels (id, data, status, created_at) VALUES
      ('bk1', '{"title":"星河剑歌"}', 1, 1),
      ('bk2', '{"title":"别的书"}', 1, 2),
      ('bk_gone', '{"title":"已删除"}', 3, 3);
    ${BOOK_STATUS_SEED}
  `);
  const insert = database.prepare(
    "INSERT INTO items (id, status, data, pub_date, book_id) VALUES (?, ?, ?, ?, ?)",
  );
  for (const row of chapters) insert.run(...row);
  return new SqliteVolumeDb(database);
}

/** A TCM item row: chapters (篇章) carry `section`, sections (条文) carry
 *  `receiptNo` and point at their chapter via `tcm_parent_id`, and fang entries
 *  live on the fang container but point at the real book via `sourceBookId`. */
function tcmItem(
  id: string,
  bookId: string,
  kind: "chapter" | "section" | "fang" | "yao" | "term",
  microfeed: Record<string, unknown>,
  parentId: string | null = null,
  title = id,
  status = 1,
): [string, number, string, string, string, string, string] {
  return [
    id,
    status,
    JSON.stringify({title, _microfeed: {bookId, ...microfeed}}),
    "2026-01-01T00:00:00Z",
    bookId,
    kind,
    parentId ?? "",
  ];
}

function databaseWithTcmBook(): VolumeDb {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE channels (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      status INTEGER NOT NULL,
      created_at INTEGER
    );
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      status INTEGER NOT NULL,
      pub_date TEXT,
      book_id TEXT,
      tcm_kind TEXT,
      tcm_parent_id TEXT
    );
    INSERT INTO channels (id, data, status, created_at) VALUES
      ('bk_tcm', '{"title":"伤寒杂病论・(桂林古本)"}', 1, 1),
      ('tcmfang0001', '{"title":"方剂","_microfeed":{"tcmContainer":"fang"}}', 1, 2);
    ${BOOK_STATUS_SEED}
  `);
  const insert = database.prepare(
    "INSERT INTO items (id, status, data, pub_date, book_id, tcm_kind, tcm_parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const rows = [
    tcmItem("ch1", "bk_tcm", "chapter", {section: 10010002}, null, "辨太阳病脉证并治上"),
    tcmItem("ch2", "bk_tcm", "chapter", {section: 10010001}, null, "平脉法第一"),
    // Sections of 平脉法第一 — receiptNo order must be preserved.
    tcmItem("sec1", "bk_tcm", "section", {receiptNo: 1001000102}, "ch2", "第1001000102条・平脉法第一"),
    tcmItem("sec2", "bk_tcm", "section", {receiptNo: 1001000101}, "ch2", "第1001000101条・平脉法第一"),
    // Sections of 辨太阳病脉证并治上.
    tcmItem("sec3", "bk_tcm", "section", {receiptNo: 1001000201}, "ch1", "第1001000201条・辨太阳病脉证并治上"),
    // Fang entries: they live on the container channel but belong to bk_tcm.
    tcmItem("fang1", "tcmfang0001", "fang", {no: 2, sourceBookId: "bk_tcm"}, null, "乌头桂枝汤"),
    tcmItem("fang2", "tcmfang0001", "fang", {no: 1, sourceBookId: "bk_tcm"}, null, "下瘀血汤"),
  ];
  for (const row of rows) insert.run(...row);
  return new SqliteVolumeDb(database);
}

/** 中药书的形状：一行根篇章（`chapter`）挂着全部 `yao` 条目，`yao` 没有 `receiptNo`。 */
function databaseWithYaoBook(): VolumeDb {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE channels (id TEXT PRIMARY KEY, data TEXT NOT NULL, status INTEGER NOT NULL, created_at INTEGER);
    CREATE TABLE items (
      id TEXT PRIMARY KEY, data TEXT NOT NULL, status INTEGER NOT NULL,
      pub_date TEXT, book_id TEXT, tcm_kind TEXT, tcm_parent_id TEXT
    );
    INSERT INTO channels (id, data, status, created_at) VALUES ('bk_yao', '{"title":"中药"}', 1, 1);
  `);
  const insert = database.prepare(
    "INSERT INTO items (id, status, data, pub_date, book_id, tcm_kind, tcm_parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run(
    "chYao", 1,
    JSON.stringify({title: "中药", _microfeed: {bookId: "bk_yao", section: 1}}),
    "2026-01-01T00:00:00Z", "bk_yao", "chapter", "",
  );
  // 故意乱序插入；id 也不按 no 排（idC=no1, idA=no2, idB=no3），验证顺序来自 `no`。
  for (const row of [
    tcmItem("idC", "bk_yao", "yao", {no: 1}, "chYao", "1、甘草"),
    tcmItem("idA", "bk_yao", "yao", {no: 2}, "chYao", "2、桂枝"),
    tcmItem("idB", "bk_yao", "yao", {no: 3}, "chYao", "3、生姜"),
  ]) insert.run(...row);
  return new SqliteVolumeDb(database);
}

describe("novel-cms book picker and book existence", () => {
  it("offers live books only in the book picker", async () => {
    const books = await listVolumeBooks(databaseWithBook([]));

    expect(books.map((book) => book.id)).toEqual(["bk1", "bk2"]);
  });

  it("hides TCM container channels from the book picker", async () => {
    const books = await listVolumeBooks(databaseWithTcmBook());

    expect(books.map((book) => book.id)).toEqual(["bk_tcm"]);
  });

  it("reports a book row that exists, including a soft-deleted one", async () => {
    const db = databaseWithBook([]);

    expect(await volumeBookExists(db, "bk1")).toBe(true);
    // 写入入口要能继续整理已删除的书（卷列表本身不按 status 过滤书目行），
    // 所以这里只看行在不在，不看状态。
    expect(await volumeBookExists(db, "bk_gone")).toBe(true);
    expect(await volumeBookExists(db, "nope")).toBe(false);
  });
});

describe("novel-cms volume entry ids (writes select one volume's ids)", () => {
  it("selects a TCM volume's sections by its chapter key", async () => {
    const ids = await listVolumeEntryIds(
      databaseWithVolumeEdges(),
      "bk_edge",
      "chA",
      true,
    );

    expect(ids.sort()).toEqual(["secA1", "secA2"]);
  });

  it("selects the herbs filed under a root chapter, not only sections", async () => {
    // 中药/名词书把 `yao`（`term` 同理）挂在根篇章下，读路径把它们当这一卷的条目
    // 渲染，写路径也必须能改到它们——只按 `tcm_kind = 'section'` 选会整批漏掉。
    const ids = await listVolumeEntryIds(databaseWithYaoBook(), "bk_yao", "chYao", true);

    expect(ids.sort()).toEqual(["idA", "idB", "idC"]);
  });

  it("selects the TCM unfiled bucket without the fang row or a deleted chapter's section", async () => {
    const ids = await listVolumeEntryIds(
      databaseWithVolumeEdges(),
      "bk_edge",
      UNFILED_VOLUME_KEY,
      true,
    );

    expect(ids).toEqual(["secOrphan"]);
  });

  it("selects nothing for an unknown, deleted, foreign, or empty volume key", async () => {
    const edges = databaseWithVolumeEdges();

    expect(await listVolumeEntryIds(edges, "bk_edge", "chNowhere", true)).toEqual([]);
    expect(await listVolumeEntryIds(edges, "bk_edge", "", true)).toEqual([]);
    // 被软删的篇章不作为卷渲染，所以它的键也选不出任何 id。
    expect(await listVolumeEntryIds(edges, "bk_edge", "chGone", true)).toEqual([]);
    // 别的书的篇章键：一行都不许选中。
    expect(await listVolumeEntryIds(databaseWithTwoTcmBooks(), "bk_a", "chB1", true))
      .toEqual([]);
  });

  it("selects a tag volume's ids by its label and the unfiled bucket by the empty label", async () => {
    const db = databaseWithBook([
      chapter("itm1", "bk1", "第一卷", 1),
      chapter("itm2", "bk1", "第二卷", 1),
      chapter("itm3", "bk1", "第一卷", 2),
      chapter("itm4", "bk1", "", 5),
      chapter("itm5", "bk2", "第一卷", 1),
      chapter("itm6", "bk1", "第一卷", 3, {status: 3}),
    ]);

    expect((await listVolumeEntryIds(db, "bk1", "第一卷", false)).sort())
      .toEqual(["itm1", "itm3"]);
    expect(await listVolumeEntryIds(db, "bk1", UNFILED_VOLUME_KEY, false))
      .toEqual(["itm4"]);
    expect(await listVolumeEntryIds(db, "bk1", "第三卷", false)).toEqual([]);
  });
});

/** Items for the volume-list fixture with the awkward shapes the counts have to
 *  get right: an empty volume, a soft-deleted chapter, a stray section, and a
 *  fang row that carries the real book's `book_id` (as production fangs do). */
function databaseWithVolumeEdges(): VolumeDb {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE channels (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      status INTEGER NOT NULL,
      created_at INTEGER
    );
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      status INTEGER NOT NULL,
      pub_date TEXT,
      book_id TEXT,
      tcm_kind TEXT,
      tcm_parent_id TEXT
    );
    INSERT INTO channels (id, data, status, created_at) VALUES
      ('bk_edge', '{"title":"边缘典籍"}', 1, 1);
  `);
  const insert = database.prepare(
    "INSERT INTO items (id, status, data, pub_date, book_id, tcm_kind, tcm_parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const rows = [
    tcmItem("chA", "bk_edge", "chapter", {section: 1}, null, "卷甲"),
    tcmItem("chB", "bk_edge", "chapter", {section: 2}, null, "卷乙（空）"),
    tcmItem("chGone", "bk_edge", "chapter", {section: 3}, null, "已删篇章", 3),
    tcmItem("secA1", "bk_edge", "section", {receiptNo: 101}, "chA"),
    tcmItem("secA2", "bk_edge", "section", {receiptNo: 102}, "chA"),
    // 挂在被软删篇章下：既不作为卷展示，也不算未归类。
    tcmItem("secGone", "bk_edge", "section", {receiptNo: 301}, "chGone"),
    // 分组键指向本书之外：未归类。
    tcmItem("secOrphan", "bk_edge", "section", {receiptNo: 901}, "chNowhere"),
    // 方剂带着本书的 book_id 却没有父项，它不属于卷/章树，不得数进未归类。
    tcmItem("fangA", "bk_edge", "fang", {no: 1}, null, "乌头桂枝汤"),
  ];
  for (const row of rows) insert.run(...row);
  return new SqliteVolumeDb(database);
}

describe("novel-cms volume list (book click reads 卷 only)", () => {
  it("lists a TCM book's volumes with entry counts, keyed by chapter id", async () => {
    const list = await listBookVolumes(databaseWithTcmBook(), "bk_tcm");

    expect(list.book).toEqual({id: "bk_tcm", title: "伤寒杂病论・(桂林古本)"});
    expect(list.tcm).toBe(true);
    // 篇章 = 卷，按源 section 排序（平脉法第一 = 10010001 在前）。
    expect(list.volumes).toEqual([
      {chapterCount: 2, key: "ch2", name: "平脉法第一", order: 10010001},
      {chapterCount: 1, key: "ch1", name: "辨太阳病脉证并治上", order: 10010002},
    ]);
  });

  it("counts an empty volume as zero and keeps the unfiled bucket last", async () => {
    const list = await listBookVolumes(databaseWithVolumeEdges(), "bk_edge");

    expect(list.volumes.map((volume) => [volume.key, volume.chapterCount])).toEqual([
      ["chA", 2],
      ["chB", 0],
      [UNFILED_VOLUME_KEY, 1],
    ]);
    expect(list.volumes.at(-1)?.name).toBe("");
  });

  it("hides a soft-deleted volume without moving its entries into the unfiled bucket", async () => {
    const list = await listBookVolumes(databaseWithVolumeEdges(), "bk_edge");

    expect(list.volumes.map((volume) => volume.key)).not.toContain("chGone");
    // 未归类只有 secOrphan 一条：secGone 挂在被删篇章下（既有看板口径），
    // fangA 没有父项但不是条文，属于独立的方剂目录。
    expect(list.volumes.find((volume) => volume.key === UNFILED_VOLUME_KEY)
      ?.chapterCount).toBe(1);
  });

  it("counts the herbs filed under a root chapter (中药书形状)", async () => {
    const list = await listBookVolumes(databaseWithYaoBook(), "bk_yao");
    expect(list.volumes).toEqual([
      {chapterCount: 3, key: "chYao", name: "中药", order: 1},
    ]);
  });

  it("returns no volumes for a book that does not exist", async () => {
    const list = await listBookVolumes(databaseWithBook([]), "nope");

    expect(list.book).toBeNull();
    expect(list.tcm).toBe(false);
    expect(list.volumes).toEqual([]);
  });

  it("groups a tag-based book by its volume tags, explicit order first and unfiled last", async () => {
    const list = await listBookVolumes(databaseWithBook([
      chapter("itm1", "bk1", "第一卷 初入江湖", 2),
      chapter("itm2", "bk1", "第一卷 初入江湖", 1),
      chapter("itm3", "bk1", "第二卷 星河初现", 1),
      chapter("itm4", "bk1", "", 5),
    ]), "bk1");

    expect(list.tcm).toBe(false);
    expect(list.volumes).toEqual([
      {chapterCount: 2, key: "第一卷 初入江湖", name: "第一卷 初入江湖", order: null},
      {chapterCount: 1, key: "第二卷 星河初现", name: "第二卷 星河初现", order: null},
      {chapterCount: 1, key: UNFILED_VOLUME_KEY, name: "", order: null},
    ]);
  });

  it("lets an explicit volume order outrank chapter order (tag books)", async () => {
    const list = await listBookVolumes(databaseWithBook([
      chapter("itm1", "bk1", "第一卷", 1),
      chapter("itm2", "bk1", "第二卷", 1, {microfeed: {volumeOrder: 0}}),
    ]), "bk1");

    expect(list.volumes.map((volume) => [volume.key, volume.order])).toEqual([
      ["第二卷", 0],
      ["第一卷", null],
    ]);
  });

  it("orders tied tag volumes by when their first chapter was published", async () => {
    const list = await listBookVolumes(databaseWithBook([
      chapter("itm1", "bk1", "第二卷", 1, {pubDate: "2026-03-01T00:00:00Z"}),
      chapter("itm2", "bk1", "第一卷", 1, {pubDate: "2026-01-01T00:00:00Z"}),
    ]), "bk1");

    expect(list.volumes.map((volume) => volume.name)).toEqual(["第一卷", "第二卷"]);
  });

  it("keeps other books' entries and deleted entries out of the tag counts", async () => {
    const list = await listBookVolumes(databaseWithBook([
      chapter("itm1", "bk1", "第一卷", 1),
      chapter("itm2", "bk2", "第一卷", 1),
      chapter("itm3", "bk1", "第一卷", 2, {status: 3}),
    ]), "bk1");

    expect(list.volumes).toEqual([
      {chapterCount: 1, key: "第一卷", name: "第一卷", order: null},
    ]);
  });
});

/** `COALESCE(receiptNo, no)` 的回落与并列回落 id：插入顺序刻意与期望顺序相反。 */
function databaseWithSectionOrderEdges(): VolumeDb {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE channels (id TEXT PRIMARY KEY, data TEXT NOT NULL, status INTEGER NOT NULL, created_at INTEGER);
    CREATE TABLE items (
      id TEXT PRIMARY KEY, data TEXT NOT NULL, status INTEGER NOT NULL,
      pub_date TEXT, book_id TEXT, tcm_kind TEXT, tcm_parent_id TEXT
    );
    INSERT INTO channels (id, data, status, created_at) VALUES ('bk_ord', '{"title":"排序典籍"}', 1, 1);
  `);
  const insert = database.prepare(
    "INSERT INTO items (id, status, data, pub_date, book_id, tcm_kind, tcm_parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const row of [
    tcmItem("chO", "bk_ord", "chapter", {section: 1}, null, "卷一"),
    tcmItem("secD", "bk_ord", "section", {receiptNo: 3}, "chO"),
    tcmItem("secC", "bk_ord", "section", {no: 99, receiptNo: 3}, "chO"),
    // 没有 receiptNo 的行回落到 `no`，与带 receiptNo 的行同池排序。
    tcmItem("secB", "bk_ord", "section", {no: 2}, "chO"),
    tcmItem("secA", "bk_ord", "section", {receiptNo: 1}, "chO"),
  ]) insert.run(...row);
  return new SqliteVolumeDb(database);
}

/** 两本书各有自己的篇章与条文：跨书取内容必须是空的。 */
function databaseWithTwoTcmBooks(): VolumeDb {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE channels (id TEXT PRIMARY KEY, data TEXT NOT NULL, status INTEGER NOT NULL, created_at INTEGER);
    CREATE TABLE items (
      id TEXT PRIMARY KEY, data TEXT NOT NULL, status INTEGER NOT NULL,
      pub_date TEXT, book_id TEXT, tcm_kind TEXT, tcm_parent_id TEXT
    );
    INSERT INTO channels (id, data, status, created_at) VALUES
      ('bk_a', '{"title":"甲典籍"}', 1, 1),
      ('bk_b', '{"title":"乙典籍"}', 1, 2);
  `);
  const insert = database.prepare(
    "INSERT INTO items (id, status, data, pub_date, book_id, tcm_kind, tcm_parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const row of [
    tcmItem("chA1", "bk_a", "chapter", {section: 1}, null, "甲卷"),
    tcmItem("secA1", "bk_a", "section", {receiptNo: 11}, "chA1"),
    tcmItem("chB1", "bk_b", "chapter", {section: 1}, null, "乙卷"),
    tcmItem("secB1", "bk_b", "section", {receiptNo: 21}, "chB1"),
  ]) insert.run(...row);
  return new SqliteVolumeDb(database);
}

describe("novel-cms volume entries (volume click reads that volume only)", () => {
  it("lists a TCM volume's sections in receiptNo order with a 1-based index", async () => {
    const result = await listVolumeEntries(databaseWithVolumeEdges(), "bk_edge", "chA");

    expect(result.name).toBe("卷甲");
    expect(result.tcm).toBe(true);
    expect(result.unknown).toBe(false);
    expect(result.entries.map((entry) => [entry.index, entry.id])).toEqual([
      [1, "secA1"],
      [2, "secA2"],
    ]);
  });

  it("falls back to `no` when a section has no receiptNo and breaks ties by id", async () => {
    const result = await listVolumeEntries(databaseWithSectionOrderEdges(), "bk_ord", "chO");

    expect(result.entries.map((entry) => entry.id)).toEqual([
      "secA",
      "secB",
      "secC",
      "secD",
    ]);
  });

  it("lists a yao book's herbs under the root chapter, ordered by no", async () => {
    // 中药书把整批 `yao` 经 `tcm_parent_id` 挂到一根篇章下。yao 没有 `receiptNo`，
    // 排序必须回落到 `no`（与 /book/<id>/ 目录的 getTcmBookEntries 同一条键），
    // 否则 `ORDER BY receiptNo, id` 退化成按 id（哈希序）乱排。
    const result = await listVolumeEntries(databaseWithYaoBook(), "bk_yao", "chYao");

    expect(result.unknown).toBe(false);
    expect(result.entries.map((entry) => entry.id)).toEqual(["idC", "idA", "idB"]);
    expect(result.entries.map((entry) => entry.title)).toEqual([
      "1、甘草", "2、桂枝", "3、生姜",
    ]);
  });

  it("lists the unfiled bucket without the fang row or a deleted chapter's section", async () => {
    const result = await listVolumeEntries(
      databaseWithVolumeEdges(),
      "bk_edge",
      UNFILED_VOLUME_KEY,
    );

    expect(result.name).toBe("");
    expect(result.entries.map((entry) => entry.id)).toEqual(["secOrphan"]);
  });

  it("keeps a volume with no entries listable but an unknown key empty", async () => {
    const empty = await listVolumeEntries(databaseWithVolumeEdges(), "bk_edge", "chB");
    expect(empty.entries).toEqual([]);
    expect(empty.unknown).toBe(false);

    const gone = await listVolumeEntries(databaseWithVolumeEdges(), "bk_edge", "chGone");
    expect(gone.entries).toEqual([]);
    expect(gone.unknown).toBe(true);
  });

  it("refuses to read another book's volume", async () => {
    const result = await listVolumeEntries(databaseWithTwoTcmBooks(), "bk_a", "chB1");

    expect(result.entries).toEqual([]);
    expect(result.unknown).toBe(true);
    // 乙典籍的条文一行都不该回到这份载荷里。
    expect(JSON.stringify(result)).not.toContain("secB1");
  });

  it("orders a tag volume's chapters by chapterNo, then publish date, then id", async () => {
    const result = await listVolumeEntries(databaseWithBook([
      chapter("itm3", "bk1", "第一卷 初入江湖", 2, {pubDate: "2026-02-02T00:00:00Z"}),
      chapter("itm1", "bk1", "第一卷 初入江湖", 1, {pubDate: "2026-03-03T00:00:00Z"}),
      chapter("itm2", "bk1", "第一卷 初入江湖", 1, {pubDate: "2026-01-01T00:00:00Z"}),
      chapter("itm4", "bk2", "第一卷 初入江湖", 1),
      chapter("itm5", "bk1", "第一卷 初入江湖", 1, {status: 3}),
    ]), "bk1", "第一卷 初入江湖");

    expect(result.name).toBe("第一卷 初入江湖");
    expect(result.tcm).toBe(false);
    expect(result.entries.map((entry) => [entry.index, entry.id])).toEqual([
      [1, "itm2"],
      [2, "itm1"],
      [3, "itm3"],
    ]);
  });

  it("serves the unfiled tag bucket and reports a stale volume label as unknown", async () => {
    const db = databaseWithBook([
      chapter("itm1", "bk1", "第一卷", 1),
      chapter("itm2", "bk1", "", 5),
    ]);

    const unfiled = await listVolumeEntries(db, "bk1", UNFILED_VOLUME_KEY);
    expect(unfiled.name).toBe("");
    expect(unfiled.entries.map((entry) => entry.id)).toEqual(["itm2"]);
    expect(unfiled.unknown).toBe(false);

    const stale = await listVolumeEntries(db, "bk1", "第三卷");
    expect(stale.entries).toEqual([]);
    expect(stale.unknown).toBe(true);
  });
});
