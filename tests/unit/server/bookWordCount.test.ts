import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {
  bookWordCounts,
  chapterWordCount,
  countBodyText,
  type WordCountDb,
  type WordCountDbPreparedStatement,
} from "@/server/feed/bookWordCount";

type SqlInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;

class SqliteStatement implements WordCountDbPreparedStatement {
  private readonly statement: ReturnType<DatabaseSync["prepare"]>;
  private values: SqlInputValue[] = [];

  constructor(database: DatabaseSync, query: string) {
    this.statement = database.prepare(query);
  }

  bind(...values: unknown[]): WordCountDbPreparedStatement {
    this.values = values as SqlInputValue[];
    return this;
  }

  async all(): Promise<{results: Record<string, unknown>[]}> {
    return {results: this.statement.all(...this.values) as Record<string, unknown>[]};
  }
}

class SqliteDb implements WordCountDb {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): WordCountDbPreparedStatement {
    return new SqliteStatement(this.database, query);
  }
}

function databaseWith(chapters: Array<Record<string, unknown>>): WordCountDb {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      status INTEGER NOT NULL
    );
  `);
  const insert = database.prepare(
    "INSERT INTO items (id, data, status) VALUES (?, ?, ?)",
  );
  chapters.forEach((chapter, index) => {
    insert.run(`chap${index}`, JSON.stringify(chapter), Number(chapter.status ?? 1));
  });
  return new SqliteDb(database);
}

describe("word count derivation", () => {
  it("counts characters with the markup and whitespace removed", () => {
    expect(countBodyText("<p>陆尘握紧断剑。</p>")).toBe(7);
    expect(countBodyText("  星河\n  入梦  ")).toBe(4);
    expect(countBodyText("")).toBe(0);
    expect(countBodyText(null)).toBe(0);
  });

  it("prefers description and never sums derived copies of the same body", () => {
    // `content_text` is derived FROM `description`; adding them would double it.
    expect(chapterWordCount({
      content_text: "陆尘握紧断剑。",
      description: "<p>陆尘握紧断剑。</p>",
    })).toBe(7);
  });

  it("totals a book from its published chapters only", async () => {
    const db = databaseWith([
      {_microfeed: {bookId: "book1"}, description: "<p>第一章</p>"},
      {_microfeed: {bookId: "book1"}, description: "<p>第二章</p>"},
      {_microfeed: {bookId: "book2"}, description: "<p>别的书</p>"},
      // Unpublished: on the site it does not exist, so it must not count.
      {_microfeed: {bookId: "book1"}, description: "<p>草稿</p>", status: 2},
      // No book tag at all.
      {description: "<p>无主章节</p>"},
    ]);
    expect(await bookWordCounts(db)).toEqual(new Map([["book1", 6], ["book2", 3]]));
  });

  it("ignores whatever the chapter pocket declares", async () => {
    // The sample books declared ~700 characters per chapter against bodies of
    // ~50. A declaration is never recomputed, so it must not be trusted.
    const db = databaseWith([{
      _microfeed: {bookId: "book1", wordCount: 980000},
      description: "<p>短</p>",
    }]);
    expect((await bookWordCounts(db)).get("book1")).toBe(1);
  });
});
