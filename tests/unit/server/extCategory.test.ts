import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {SqliteStatement} from "../support/sqlite-statement";
import {
  listCategoryNav,
  listChannelsByGenre,
  listPublishedBookSamples,
  searchPublishedBooks,
  type CategoryDb,
  type CategoryDbPreparedStatement,
} from "@/server/feed/extCategory";



class SqliteCategoryDb implements CategoryDb {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): CategoryDbPreparedStatement {
    return new SqliteStatement(this.database, query);
  }
}

function databaseWithCategories(): CategoryDb {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE ext_category (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      parent_id TEXT,
      sort INTEGER DEFAULT 0,
      visible INTEGER DEFAULT 1,
      created_at INTEGER
    );
    CREATE TABLE channels (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      genre TEXT,
      status INTEGER NOT NULL,
      is_primary INTEGER,
      created_at TEXT
    );
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      status INTEGER NOT NULL,
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
    INSERT INTO ext_category (id, name, slug, sort, visible, created_at) VALUES
      ('cat_empty', '空分类', 'empty', 1, 1, 1),
      ('cat_book', '东方玄幻', 'eastern-fantasy', 2, 1, 2),
      ('cat_hidden', '隐藏分类', 'hidden', 3, 0, 3);
    INSERT INTO channels (id, data, genre, status, is_primary, created_at) VALUES
      ('book_1', '{"title":"星河剑歌"}', 'cat_book', 1, NULL, '2026-01-01'),
      ('tcmfang0001', '{"title":"方剂","_microfeed":{"tcmContainer":"fang"}}', 'cat_book', 1, NULL, '2026-01-02');
  `);
  return new SqliteCategoryDb(database);
}

describe("novel-cms public categories", () => {
  it("shows every visible category, including categories with no book", async () => {
    const categories = await listCategoryNav(databaseWithCategories());

    expect(categories.map(({id, bookCount}) => ({id, bookCount}))).toEqual([
      {id: "cat_empty", bookCount: 0},
      {id: "cat_book", bookCount: 1},
    ]);
  });

  it("lists published books by genre using numeric status values", async () => {
    const books = await listChannelsByGenre(
      databaseWithCategories(),
      "cat_book",
    );

    expect(books).toEqual([{
      id: "book_1",
      image: "",
      link: "",
      title: "星河剑歌",
    }]);
  });

  it("keeps container channels off the shelf, the category page and search", async () => {
    const db = databaseWithCategories();

    // 方剂 anchors the real books' items instead of being a work of its own: a
    // card for it would only open a 404, so every public listing skips it.
    expect((await listPublishedBookSamples(db)).map(({id}) => id))
      .toEqual(["book_1"]);
    expect((await listChannelsByGenre(db, "cat_book")).map(({id}) => id))
      .toEqual(["book_1"]);
    expect(await searchPublishedBooks(db, "方剂")).toEqual([]);
    expect((await searchPublishedBooks(db, "星河")).map(({id}) => id))
      .toEqual(["book_1"]);
  });
});
