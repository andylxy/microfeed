import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {
  getTcmBookEntries,
  listCategoryNav,
  listChannelsByGenre,
  type CategoryDb,
  type CategoryDbAllResult,
  type CategoryDbPreparedStatement,
} from "@/server/feed/extCategory";

type SqlInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;

class SqliteStatement implements CategoryDbPreparedStatement {
  private readonly statement: ReturnType<DatabaseSync["prepare"]>;
  private values: SqlInputValue[] = [];

  constructor(database: DatabaseSync, query: string) {
    this.statement = database.prepare(query);
  }

  bind(...values: unknown[]): CategoryDbPreparedStatement {
    this.values = values as SqlInputValue[];
    return this;
  }

  async all(): Promise<CategoryDbAllResult> {
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
      status INTEGER NOT NULL
    );
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      status INTEGER NOT NULL,
      content_text TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO ext_category (id, name, slug, sort, visible, created_at) VALUES
      ('cat_empty', '空分类', 'empty', 1, 1, 1),
      ('cat_book', '东方玄幻', 'eastern-fantasy', 2, 1, 2),
      ('cat_hidden', '隐藏分类', 'hidden', 3, 0, 3);
    INSERT INTO channels (id, data, genre, status) VALUES
      ('book_1', '{"title":"星河剑歌"}', 'cat_book', 1);
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
});

/** Items table with the columns the TCM queries read (`book_id` + `tcm_kind`). */
function databaseWithTcmItems(): CategoryDb {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      status INTEGER NOT NULL,
      content_text TEXT NOT NULL DEFAULT '',
      pub_date TEXT,
      book_id TEXT,
      tcm_kind TEXT,
      tcm_parent_id TEXT
    );
    INSERT INTO items (id, data, status, pub_date, book_id, tcm_kind, tcm_parent_id) VALUES
      ('yao_late', '{"title":"栝蒌根","_microfeed":{"no":38}}', 1, '2024-09-14T16:56:58.000Z', 'book_yao', 'yao', NULL),
      ('yao_early', '{"title":"甘草","_microfeed":{"no":0}}', 1, '2024-09-14T16:56:57.000Z', 'book_yao', 'yao', NULL),
      ('yao_deleted', '{"title":"已删药","_microfeed":{"no":1}}', 3, '2024-09-14T16:56:57.000Z', 'book_yao', 'yao', NULL),
      ('fang_1', '{"title":"桂枝汤","_microfeed":{"no":1}}', 1, '2024-09-14T16:56:57.000Z', 'book_yao', 'fang', NULL),
      ('section_1', '{"title":"条文","_microfeed":{"receiptNo":1}}', 1, '2024-09-14T16:56:57.000Z', 'book_tcm', 'section', 'chapter_1'),
      ('chapter_1', '{"title":"平脉法第一"}', 1, '2024-09-14T16:56:57.000Z', 'book_tcm', 'chapter', NULL),
      ('yao_other', '{"title":"别的书的药","_microfeed":{"no":2}}', 1, '2024-09-14T16:56:57.000Z', 'book_other', 'yao', NULL);
  `);
  return new SqliteCategoryDb(database);
}

describe("TCM flat-entry books (中药 / 名词 collections)", () => {
  it("returns the book's own yao rows in source order, without 方剂", async () => {
    const entries = await getTcmBookEntries(
      databaseWithTcmItems(),
      "book_yao",
      "https://example.test",
    );

    expect(entries.map(({id, title}) => ({id, title}))).toEqual([
      {id: "yao_early", title: "甘草"},
      {id: "yao_late", title: "栝蒌根"},
    ]);
  });

  it("skips deleted rows and every book other than the one asked for", async () => {
    const entries = await getTcmBookEntries(
      databaseWithTcmItems(),
      "book_yao",
      "https://example.test",
    );

    const ids = entries.map(({id}) => id);
    expect(ids).not.toContain("yao_deleted");
    expect(ids).not.toContain("yao_other");
    expect(ids).not.toContain("fang_1");
  });

  it("gives each entry a web url so the catalog links somewhere", async () => {
    const entries = await getTcmBookEntries(
      databaseWithTcmItems(),
      "book_yao",
      "https://example.test",
    );

    for (const entry of entries) {
      expect(String(entry._microfeed.web_url)).toContain(String(entry.id));
    }
  });

  it("returns nothing for a book whose entries live in the 篇章/条文 tree", async () => {
    const entries = await getTcmBookEntries(
      databaseWithTcmItems(),
      "book_tcm",
      "https://example.test",
    );

    expect(entries).toEqual([]);
  });
});
