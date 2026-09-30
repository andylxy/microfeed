import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {
  listVolumeBoard,
  listVolumeBooks,
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

describe("novel-cms volume board", () => {
  it("groups a book's chapters by volume, unfiled last", async () => {
    const board = await listVolumeBoard(databaseWithBook([
      chapter("itm1", "bk1", "第一卷 初入江湖", 2),
      chapter("itm2", "bk1", "第一卷 初入江湖", 1),
      chapter("itm3", "bk1", "第二卷 星河初现", 1),
      chapter("itm4", "bk1", "", 5),
    ]), "bk1");

    expect(board.book?.title).toBe("星河剑歌");
    expect(board.groups.map((group) => group.name)).toEqual([
      "第一卷 初入江湖",
      "第二卷 星河初现",
      "",
    ]);
    expect(board.volumeNames).toEqual(["第一卷 初入江湖", "第二卷 星河初现"]);
  });

  it("sorts chapters by chapter number inside a volume", async () => {
    const board = await listVolumeBoard(databaseWithBook([
      chapter("itm1", "bk1", "第一卷", 3),
      chapter("itm2", "bk1", "第一卷", 1),
      chapter("itm3", "bk1", "第一卷", 2),
    ]), "bk1");

    const [firstVolume] = board.groups;
    expect(firstVolume?.chapters.map((c) => c.chapterNo)).toEqual([1, 2, 3]);
  });

  it("keeps other books' chapters and deleted chapters out", async () => {
    const board = await listVolumeBoard(databaseWithBook([
      chapter("itm1", "bk1", "第一卷", 1),
      chapter("itm2", "bk2", "第一卷", 1),
      chapter("itm3", "bk1", "第一卷", 2, {status: 3}),
    ]), "bk1");

    const ids = board.groups.flatMap((g) => g.chapters.map((c) => c.id));
    expect(ids).toEqual(["itm1"]);
  });

  it("orders tied volumes by when their first chapter was published", async () => {
    // Both volumes restart at chapter 1, so the tiebreak must not be the name:
    // sorting by name would put 第二卷 ("er") ahead of 第一卷 ("yi").
    const board = await listVolumeBoard(databaseWithBook([
      chapter("itm1", "bk1", "第二卷", 1, {pubDate: "2026-03-01T00:00:00Z"}),
      chapter("itm2", "bk1", "第一卷", 1, {pubDate: "2026-01-01T00:00:00Z"}),
    ]), "bk1");

    expect(board.groups.map((g) => g.name)).toEqual(["第一卷", "第二卷"]);
  });

  it("lets an explicit volume order override chapter order", async () => {
    const board = await listVolumeBoard(databaseWithBook([
      chapter("itm1", "bk1", "第一卷", 1),
      chapter("itm2", "bk1", "第二卷", 1, {microfeed: {volumeOrder: 0}}),
    ]), "bk1");

    const [firstVolume] = board.groups;
    expect(firstVolume?.name).toBe("第二卷");
    expect(firstVolume?.order).toBe(0);
  });

  it("returns no groups for a book that does not exist", async () => {
    const board = await listVolumeBoard(databaseWithBook([]), "nope");

    expect(board.book).toBeNull();
    expect(board.groups).toEqual([]);
  });

  it("offers live books only in the book picker", async () => {
    const books = await listVolumeBooks(databaseWithBook([]));

    expect(books.map((book) => book.id)).toEqual(["bk1", "bk2"]);
  });

  it("hides TCM container channels from the book picker", async () => {
    const books = await listVolumeBooks(databaseWithTcmBook());

    expect(books.map((book) => book.id)).toEqual(["bk_tcm"]);
  });

  it("builds a TCM book's board from chapters and sections", async () => {
    const board = await listVolumeBoard(databaseWithTcmBook(), "bk_tcm");

    // 篇章 = 卷，按源 section 排序；条文 = 卷内章。方剂不是卷/章：它属于本书
    // 但以条目形式出现在管理列表，卷面板不出现独立的「方剂」卷。
    expect(board.book?.title).toBe("伤寒杂病论・(桂林古本)");
    // TCM 书同样可维护：写操作由 volume-handlers 翻译成 tcm_parent_id /
    // 篇章改名，因此看板不再是只读。
    expect(board.readOnly).toBe(false);
    expect(board.groups.map((group) => group.name)).toEqual([
      "平脉法第一",
      "辨太阳病脉证并治上",
    ]);

    const [first] = board.groups;
    expect(first?.chapters.map((c) => ({id: c.id, no: c.chapterNo, vol: c.volume})))
      .toEqual([
        {id: "sec2", no: 1, vol: "平脉法第一"},
        {id: "sec1", no: 2, vol: "平脉法第一"},
      ]);

    const [, second] = board.groups;
    expect(second?.chapters.map((c) => c.id)).toEqual(["sec3"]);
    expect(board.volumeNames).toEqual([
      "平脉法第一",
      "辨太阳病脉证并治上",
    ]);
    // Fang entries must not leak into the volume board.
    const allIds = board.groups.flatMap((g) => g.chapters.map((c) => c.id));
    expect(allIds).not.toContain("fang1");
    expect(allIds).not.toContain("fang2");
  });

  it("does not treat an empty TCM-ish item set as a TCM book", async () => {
    // A normal novel book has no tcm_kind items, so it keeps the tag-based,
    // writable board.
    const board = await listVolumeBoard(databaseWithBook([
      chapter("itm1", "bk1", "第一卷", 1),
    ]), "bk1");

    expect(board.readOnly).toBeUndefined();
    expect(board.groups.map((group) => group.name)).toEqual(["第一卷"]);
  });

  it("orders yao entries under a chapter by no when receiptNo is null (matches book catalog)", async () => {
    // 中药书把 172 条 yao 经 tcm_parent_id 挂到一个根 chapter 下显示。yao 没有
    // receiptNo，必须回落到 `no`（与 /book/<id>/ 目录的 getTcmBookEntries 排序一致），
    // 否则 ORDER BY receiptNo,id 退化为按 id（哈希序）乱排。
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
    // 故意乱序插入；id 也不按 no 排（idC=no1, idA=no2, idB=no3），验证确实按 no 而非 id。
    const yao = [
      tcmItem("idC", "bk_yao", "yao", {no: 1}, "chYao", "1、甘草"),
      tcmItem("idA", "bk_yao", "yao", {no: 2}, "chYao", "2、桂枝"),
      tcmItem("idB", "bk_yao", "yao", {no: 3}, "chYao", "3、生姜"),
    ];
    for (const r of yao) insert.run(...r);

    const board = await listVolumeBoard(new SqliteVolumeDb(database), "bk_yao");
    const [group] = board.groups;
    expect(group?.chapters.map((c) => c.id)).toEqual(["idC", "idA", "idB"]);
    expect(group?.chapters.map((c) => c.title)).toEqual([
      "1、甘草", "2、桂枝", "3、生姜",
    ]);
  });
});
