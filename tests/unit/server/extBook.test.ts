import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {
  createAdminBook,
  deleteAdminBook,
  getAdminBook,
  listAdminBooks,
  listBookCategoryOptions,
  loadBooksBoard,
  purgeAdminBook,
  readBookStatusCode,
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
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      content_text TEXT NOT NULL DEFAULT '',
      book_id TEXT
    );
    CREATE TABLE ext_book_stats (
      book_id            VARCHAR(11) PRIMARY KEY,
      chapters_published INTEGER NOT NULL DEFAULT 0,
      words_published    INTEGER NOT NULL DEFAULT 0,
      chapters_all       INTEGER NOT NULL DEFAULT 0,
      words_all          INTEGER NOT NULL DEFAULT 0,
      computed_at_ms     INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE ext_category (
      id VARCHAR(11) PRIMARY KEY,
      name TEXT,
      slug TEXT,
      parent_id TEXT,
      sort INTEGER DEFAULT 0,
      visible INTEGER DEFAULT 1
    );
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
      color_bg TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE ext_marker_citations (
      book_id TEXT NOT NULL,
      marker_code TEXT NOT NULL,
      marker_name TEXT NOT NULL,
      section_id TEXT NOT NULL,
      section_title TEXT NOT NULL DEFAULT '',
      section_seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (book_id, marker_code, marker_name, section_id)
    );
    CREATE TABLE ext_marker_citation_state (
      book_id TEXT PRIMARY KEY,
      computed_at_ms INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO ext_book_status
      (code, name_zh, name_en, form_selectable, public_visible, admin_list_hidden, is_system, sort) VALUES
      (1, '显示', 'Visible', 1, 1, 0, 1, 100),
      (2, '隐藏', 'Hidden', 1, 0, 0, 1, 200),
      (3, '已删除', 'Deleted', 0, 0, 1, 1, 300);
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
    "INSERT INTO items (id, status, data, pub_date, content_text, book_id) " +
      "VALUES (?,?,?,?,?,?)",
  );
  // Mirror the production write path: `content_text` is the body with markup
  // stripped, `book_id` is the denormalised `_microfeed.bookId` (ADR-0006).
  // Both are what `bookStats` reads, so the fixture has to carry them.
  const addItem = (
    id: string,
    status: number,
    data: Record<string, unknown>,
    pubDate: string,
  ) => {
    const description = typeof data.description === "string" ? data.description : "";
    const pocket = (data._microfeed ?? {}) as Record<string, unknown>;
    insertItem.run(
      id,
      status,
      JSON.stringify(data),
      pubDate,
      description.replace(/<[^>]+>/g, ""),
      typeof pocket.bookId === "string" ? pocket.bookId : null,
    );
  };
  addItem("chap1", 1, {
    description: "<p>陆尘握紧断剑。</p>",
    title: "第一章",
    _microfeed: {bookId: "book2", chapterNo: 1, wordCount: 999999},
  }, "2026-03-01 00:00:00");
  addItem("chap2", 1, {
    description: "<p>海面浮起灯火。</p>",
    title: "第二章",
    _microfeed: {bookId: "book2", chapterNo: 2},
  }, "2026-03-02 00:00:00");
  addItem("chap3", 1, {
    description: "<p>星河入梦。</p>",
    title: "主频道章节",
    _microfeed: {bookId: "primary1", chapterNo: 1},
  }, "2026-01-01 00:00:00");
  // A deleted chapter must not be counted.
  addItem("chap4", 3, {
    title: "已删除", _microfeed: {bookId: "book2", chapterNo: 3},
  }, "2026-03-03 00:00:00");
}

describe("novel-cms book management", () => {
  it("lists every book with chapter counts and category names", async () => {
    const db = emptyDatabase();
    seed(db);
    const books = await listAdminBooks(db);

    // 软删除的作品也在列（isDeleted 标记），由前端「已删除」筹码单列。
    expect(books.map((book) => book.id)).toEqual(["primary1", "book2", "gone3"]);
    expect(books.map((book) => book.isDeleted)).toEqual([false, false, true]);
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
    // 软删除不从列表消失（恢复要靠它），只是打上 isDeleted。
    const books = await listAdminBooks(db);
    expect(books).toHaveLength(3);
    expect(books.find((book) => book.id === "book2")?.isDeleted).toBe(true);

    expect(await deleteAdminBook(db, "primary1")).toBe(false);
    expect(await deleteAdminBook(db, "missing")).toBe(false);
  });

  it("restores a soft-deleted book through the normal update path", async () => {
    const db = emptyDatabase();
    seed(db);
    await deleteAdminBook(db, "book2");

    // 恢复 = 切回表单可选状态（服务端只放行这一类切换）。
    const restored = await updateAdminBook(db, "book2", {status: 1});
    expect(restored).toMatchObject({status: 1});
    const books = await listAdminBooks(db);
    expect(books.find((book) => book.id === "book2")?.isDeleted).toBe(false);
  });

  it("purges a book with its chapters and auxiliary rows", async () => {
    const db = emptyDatabase();
    seed(db);
    const database = (db as unknown as {database: DatabaseSync}).database;
    database.prepare(
      "INSERT INTO ext_book_stats (book_id, chapters_all) VALUES ('book2', 2)",
    ).run();
    database.prepare(
      "INSERT INTO ext_marker_citations (book_id, marker_code, marker_name, section_id) " +
        "VALUES ('book2', 'm1', '标记', 'chap1')",
    ).run();
    database.prepare(
      "INSERT INTO ext_marker_citation_state (book_id, computed_at_ms) " +
        "VALUES ('book2', 1)",
    ).run();

    // 两步流程：先软删除，再物理删除。
    await deleteAdminBook(db, "book2");
    const result = await purgeAdminBook(db, "book2");
    // 3 = 两章已发布 + 一章软删除（chap4）：物理删除连软删的章节一起清，
    // 不留孤儿行，所以计数含它。
    expect(result).toEqual({purged: true, chapters: 3});
    // 书行、章节行、物化行、引用索引四张表都清空。
    expect(database.prepare("SELECT id FROM channels WHERE id = 'book2'").all())
      .toHaveLength(0);
    expect(database.prepare("SELECT id FROM items WHERE book_id = 'book2'").all())
      .toHaveLength(0);
    expect(database.prepare("SELECT book_id FROM ext_book_stats WHERE book_id = 'book2'").all())
      .toHaveLength(0);
    expect(database.prepare("SELECT book_id FROM ext_marker_citations WHERE book_id = 'book2'").all())
      .toHaveLength(0);
    expect(database.prepare("SELECT book_id FROM ext_marker_citation_state WHERE book_id = 'book2'").all())
      .toHaveLength(0);
    // 别的书不受影响。
    expect(await getAdminBook(db, "primary1")).not.toBeNull();
  });

  it("refuses to purge the primary channel, a live book, or a missing book", async () => {
    const db = emptyDatabase();
    seed(db);
    expect(await purgeAdminBook(db, "primary1"))
      .toEqual({purged: false, reason: "primary"});
    // 物理删除只跑两步流程的第二段：还在展示的书必须先软删除。
    expect(await purgeAdminBook(db, "book2"))
      .toEqual({purged: false, reason: "notDeleted"});
    expect(await purgeAdminBook(db, "missing"))
      .toEqual({purged: false, reason: "missing"});
    expect(await listAdminBooks(db)).toHaveLength(3);
  });

  it("loads the board in one call", async () => {
    const db = emptyDatabase();
    seed(db);
    const board = await loadBooksBoard(db);
    // 含软删除的那本（gone3）。
    expect(board.books).toHaveLength(3);
    expect(board.categories).toEqual([{id: "cat_east", name: "东方玄幻"}]);
    // 状态字典随看板一起返回：书籍表单的显示/隐藏选项与列表行标签都读它。
    expect(board.statuses).toEqual([
      {code: 1, nameZh: "显示", nameEn: "Visible", formSelectable: true, colorFg: null, colorBg: null},
      {code: 2, nameZh: "隐藏", nameEn: "Hidden", formSelectable: true, colorFg: null, colorBg: null},
      {code: 3, nameZh: "已删除", nameEn: "Deleted", formSelectable: false, colorFg: null, colorBg: null},
    ]);
  });

  it("hides only the statuses the dictionary marks admin-list-hidden", async () => {
    const db = emptyDatabase();
    seed(db);
    const database = (db as unknown as {database: DatabaseSync}).database;
    // A custom status (code 10) is list-visible by default: the admin list
    // exclusion is a row flag, not the constant 3.
    database.prepare(
      "INSERT INTO ext_book_status " +
        "(code, name_zh, name_en, form_selectable, public_visible, " +
        "admin_list_hidden, is_system, sort) VALUES (10, '修订中', 'Revising', 1, 0, 0, 0, 400)",
    ).run();
    database.prepare(
      "INSERT INTO channels (id, status, is_primary, data, created_at) " +
        "VALUES (?,?,?,?,?)",
    ).run("book10", 10, null, JSON.stringify({title: "修订中的书"}), "2026-01-04 00:00:00");

    const books = await listAdminBooks(db);
    expect(books.map((book) => book.id)).toEqual([
      "primary1", "book2", "gone3", "book10",
    ]);
    // 只有 code 3 命中删除态；code 10 是普通自定义状态。
    expect(books.filter((book) => book.isDeleted).map((book) => book.id))
      .toEqual(["gone3"]);
    expect(await readBookStatusCode(db, "book10")).toBe(10);
  });
});
