import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {
  createAdminBook,
  deleteAdminBook,
  getAdminBook,
  listAdminBooks,
  listBookCategoryOptions,
  loadBooksBoard,
  updateAdminBook,
  type BookDb,
  type BookDbAllResult,
  type BookDbPreparedStatement,
} from "@/server/feed/extBook";

type SqlInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;

class SqliteStatement implements BookDbPreparedStatement {
  private readonly statement: ReturnType<DatabaseSync["prepare"]>;
  private values: SqlInputValue[] = [];

  constructor(database: DatabaseSync, query: string) {
    this.statement = database.prepare(query);
  }

  bind(...values: unknown[]): BookDbPreparedStatement {
    this.values = values as SqlInputValue[];
    return this;
  }

  async all(): Promise<BookDbAllResult> {
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

class SqliteBookDb implements BookDb {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): BookDbPreparedStatement {
    return new SqliteStatement(this.database, query);
  }
}

function emptyDatabase(): SqliteBookDb {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE channels (
      id VARCHAR(11) PRIMARY KEY,
      status TINYINT,
      is_primary BOOLEAN UNIQUE,
      data TEXT,
      genre TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE items (
      id VARCHAR(11) PRIMARY KEY,
      status TINYINT,
      data TEXT,
      pub_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE ext_category (
      id VARCHAR(11) PRIMARY KEY,
      name TEXT,
      slug TEXT,
      parent_id TEXT,
      sort INTEGER DEFAULT 0,
      visible INTEGER DEFAULT 1
    );
  `);
  return new SqliteBookDb(database);
}

function seed(db: SqliteBookDb) {
  const database = (db as unknown as {database: DatabaseSync}).database;
  database.prepare(
    "INSERT INTO ext_category (id, name, slug, sort, visible) VALUES (?,?,?,?,?)",
  ).run("cat_east", "东方玄幻", "eastern-fantasy", 0, 1);
  database.prepare(
    "INSERT INTO ext_category (id, name, slug, sort, visible) VALUES (?,?,?,?,?)",
  ).run("cat_hidden", "隐藏分类", "hidden", 1, 0);

  database.prepare(
    "INSERT INTO channels (id, status, is_primary, data, genre, created_at) " +
      "VALUES (?,?,?,?,?,?)",
  ).run(
    "primary1",
    1,
    1,
    JSON.stringify({
      authors: [{name: "主笔"}],
      title: "主频道",
      _microfeed: {
        bookId: "primary1", serialStatus: "serializing", genre: "cat_east",
      },
    }),
    "cat_east",
    "2026-01-01 00:00:00",
  );
  database.prepare(
    "INSERT INTO channels (id, status, is_primary, data, genre, created_at) " +
      "VALUES (?,?,?,?,?,?)",
  ).run(
    "book2",
    2,
    null,
    JSON.stringify({
      authors: [{name: "潮汐"}],
      description: "一艘船的故事。",
      image: "https://example.test/cover.png",
      title: "夜航风暴",
      _microfeed: {
        bookId: "book2", serialStatus: "finished", wordCount: 860000,
        genre: "cat_east",
      },
    }),
    "cat_east",
    "2026-01-02 00:00:00",
  );
  // A soft-deleted book must stay out of the list.
  database.prepare(
    "INSERT INTO channels (id, status, is_primary, data, created_at) " +
      "VALUES (?,?,?,?,?)",
  ).run(
    "gone3",
    3,
    null,
    JSON.stringify({title: "已删除的书"}),
    "2026-01-03 00:00:00",
  );

  const insertItem = database.prepare(
    "INSERT INTO items (id, status, data, pub_date) VALUES (?,?,?,?)",
  );
  insertItem.run("chap1", 1, JSON.stringify({
    description: "<p>陆尘握紧断剑。</p>",
    title: "第一章",
    _microfeed: {bookId: "book2", chapterNo: 1, wordCount: 999999},
  }), "2026-03-01 00:00:00");
  insertItem.run("chap2", 1, JSON.stringify({
    description: "<p>海面浮起灯火。</p>",
    title: "第二章",
    _microfeed: {bookId: "book2", chapterNo: 2},
  }), "2026-03-02 00:00:00");
  insertItem.run("chap3", 1, JSON.stringify({
    description: "<p>星河入梦。</p>",
    title: "主频道章节",
    _microfeed: {bookId: "primary1", chapterNo: 1},
  }), "2026-01-01 00:00:00");
  // A deleted chapter must not be counted.
  insertItem.run("chap4", 3, JSON.stringify({
    title: "已删除", _microfeed: {bookId: "book2", chapterNo: 3},
  }), "2026-03-03 00:00:00");
}

describe("novel-cms book management", () => {
  it("lists every book with chapter counts and category names", async () => {
    const db = emptyDatabase();
    seed(db);
    const books = await listAdminBooks(db);

    expect(books.map((book) => book.id)).toEqual(["primary1", "book2"]);
    expect(books[0]).toMatchObject({
      author: "主笔",
      categoryName: "东方玄幻",
      chapterCount: 1,
      isPrimary: true,
      status: 1,
      title: "主频道",
    });
    expect(books[1]).toMatchObject({
      author: "潮汐",
      chapterCount: 2,
      cover: "https://example.test/cover.png",
      isPrimary: false,
      serialStatus: "finished",
      status: 2,
      title: "夜航风暴",
      // Counted from the chapters, not from the 860000 the pocket declares.
      wordCount: 14,
    });
  });

  it("offers only visible categories", async () => {
    const db = emptyDatabase();
    seed(db);
    const categories = await listBookCategoryOptions(db);
    expect(categories).toEqual([{id: "cat_east", name: "东方玄幻"}]);
  });

  it("creates a book with an 11-char id and leaves is_primary NULL", async () => {
    const db = emptyDatabase();
    seed(db);
    const created = await createAdminBook(db, {
      author: "新作者",
      categoryId: "cat_east",
      title: "新书",
    });

    expect(created.id).toHaveLength(11);
    expect(created).toMatchObject({
      author: "新作者",
      categoryId: "cat_east",
      categoryName: "东方玄幻",
      chapterCount: 0,
      isPrimary: false,
      serialStatus: "serializing",
      status: 1,
      title: "新书",
    });
    // Two zeroes would violate the UNIQUE constraint on is_primary.
    const row = (db as unknown as {database: DatabaseSync}).database.prepare(
      "SELECT is_primary FROM channels WHERE id = ?",
    ).get(created.id) as Record<string, unknown>;
    expect(row.is_primary).toBeNull();
  });

  it("merges an edit without dropping fields the form does not show", async () => {
    const db = emptyDatabase();
    seed(db);
    const updated = await updateAdminBook(db, "book2", {
      author: "改过的作者",
      categoryId: "",
      title: "改过的书名",
    });

    expect(updated).toMatchObject({
      author: "改过的作者",
      categoryId: "",
      categoryName: "",
      title: "改过的书名",
    });
    // Untouched keys survive, and the genre mirror is cleared with the genre.
    expect(updated?.cover).toBe("https://example.test/cover.png");
    // Still derived from the same chapters, so an edit cannot move it.
    expect(updated?.wordCount).toBe(14);
    const row = (db as unknown as {database: DatabaseSync}).database.prepare(
      "SELECT genre FROM channels WHERE id = ?",
    ).get("book2") as Record<string, unknown>;
    expect(row.genre).toBeNull();
  });

  it("soft-deletes a book and refuses the primary channel", async () => {
    const db = emptyDatabase();
    seed(db);

    expect(await deleteAdminBook(db, "book2")).toBe(true);
    expect(await getAdminBook(db, "book2")).toMatchObject({status: 3});
    expect(await listAdminBooks(db)).toHaveLength(1);

    expect(await deleteAdminBook(db, "primary1")).toBe(false);
    expect(await deleteAdminBook(db, "missing")).toBe(false);
  });

  it("loads the board in one call", async () => {
    const db = emptyDatabase();
    seed(db);
    const board = await loadBooksBoard(db);
    expect(board.books).toHaveLength(2);
    expect(board.categories).toEqual([{id: "cat_east", name: "东方玄幻"}]);
  });
});
