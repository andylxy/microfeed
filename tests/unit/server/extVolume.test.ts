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
): [string, number, string, string] {
  return [
    id,
    extra.status ?? 1,
    JSON.stringify({
      title: id,
      _microfeed: {bookId, chapterNo, volume, ...(extra.microfeed ?? {})},
    }),
    extra.pubDate ?? "2026-01-01T00:00:00Z",
  ];
}

function databaseWithBook(chapters: Array<[string, number, string, string]>): VolumeDb {
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
      pub_date TEXT
    );
    INSERT INTO channels (id, data, status, created_at) VALUES
      ('bk1', '{"title":"星河剑歌"}', 1, 1),
      ('bk2', '{"title":"别的书"}', 1, 2),
      ('bk_gone', '{"title":"已删除"}', 3, 3);
  `);
  const insert = database.prepare(
    "INSERT INTO items (id, status, data, pub_date) VALUES (?, ?, ?, ?)",
  );
  for (const row of chapters) insert.run(...row);
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
});
