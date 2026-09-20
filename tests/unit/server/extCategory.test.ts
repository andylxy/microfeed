import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {
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
      status INTEGER NOT NULL
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
