import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {
  bookWordCounts,
  chapterWordCount,
  chunkWithinD1BindLimit,
  countBodyText,
  type WordCountDb,
  type WordCountDbPreparedStatement,
} from "@/server/feed/bookWordCount";
import {D1_MAX_BOUND_PARAMS} from "@/shared/Constants";

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

  /** Number of statements prepared. Proves an early return skipped the query. */
  prepareCalls = 0;
  /** The SQL texts, in order, so a test can inspect the emitted predicate. */
  queries: string[] = [];

  prepare(query: string): WordCountDbPreparedStatement {
    this.prepareCalls += 1;
    this.queries.push(query);
    return new SqliteStatement(this.database, query);
  }
}

function contentTextOf(chapter: Record<string, unknown>): string {
  if (typeof chapter.content_text === "string") return chapter.content_text;
  const description = chapter.description;
  return typeof description === "string" ? description.replace(/<[^>]+>/g, "") : "";
}

function databaseWith(chapters: Array<Record<string, unknown>>): WordCountDb {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      content_text TEXT,
      status INTEGER NOT NULL,
      book_id TEXT,
      pub_date TEXT,
      created_at TEXT,
      updated_at TEXT
    );
  `);
  const insert = database.prepare(
    "INSERT INTO items (id, data, content_text, status, book_id) VALUES (?, ?, ?, ?, ?)",
  );
  chapters.forEach((chapter, index) => {
    const pocket = (chapter._microfeed ?? {}) as Record<string, unknown>;
    insert.run(
      `chap${index}`,
      JSON.stringify(chapter),
      contentTextOf(chapter),
      Number(chapter.status ?? 1),
      typeof pocket.bookId === "string" ? pocket.bookId : null,
    );
  });
  return new SqliteDb(database);
}

const SAMPLE_CHAPTERS: Array<Record<string, unknown>> = [
  {_microfeed: {bookId: "book1"}, description: "<p>第一章</p>"},
  {_microfeed: {bookId: "book1"}, description: "<p>第二章</p>"},
  {_microfeed: {bookId: "book2"}, description: "<p>别的书</p>"},
  // Unpublished: on the site it does not exist, so it must not count.
  {_microfeed: {bookId: "book1"}, description: "<p>草稿</p>", status: 2},
  // No book tag at all.
  {description: "<p>无主章节</p>"},
];

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
    const db = databaseWith(SAMPLE_CHAPTERS);
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

describe("word count scoping", () => {
  it("counts only the requested books", async () => {
    const db = databaseWith(SAMPLE_CHAPTERS);
    expect(await bookWordCounts(db, ["book1"])).toEqual(new Map([["book1", 6]]));
    expect(await bookWordCounts(db, ["book1", "book2"]))
      .toEqual(new Map([["book1", 6], ["book2", 3]]));
  });

  it("matches the unscoped totals for the same set of books", async () => {
    // Scoping is an optimisation, not a different definition of "word count".
    const db = databaseWith(SAMPLE_CHAPTERS);
    const unscoped = await bookWordCounts(db);
    const scoped = await bookWordCounts(db, ["book1", "book2"]);
    expect([...scoped.entries()]).toEqual([...unscoped.entries()]);
  });

  it("still honours publish status when scoped", async () => {
    // `status = published` must survive the added predicate: the scoped path
    // reads other chapters than the row filter would alone suggest.
    const db = databaseWith(SAMPLE_CHAPTERS);
    expect((await bookWordCounts(db, ["book1"])).get("book1")).toBe(6);
  });

  it("emits the book_id predicate when scoped", async () => {
    const db = databaseWith(SAMPLE_CHAPTERS) as SqliteDb;
    await bookWordCounts(db, ["book1"]);
    expect(db.queries[0]).toContain("book_id IN (?)");
  });

  it("omits the predicate when unscoped", async () => {
    const db = databaseWith(SAMPLE_CHAPTERS) as SqliteDb;
    await bookWordCounts(db);
    expect(db.queries[0]).not.toContain("book_id IN");
  });

  it("returns nothing for an empty list without querying", async () => {
    // `IN ()` is a syntax error in SQLite, so an empty selection must short-circuit.
    const db = databaseWith(SAMPLE_CHAPTERS) as SqliteDb;
    expect(await bookWordCounts(db, [])).toEqual(new Map());
    expect(db.prepareCalls).toBe(0);
  });

  it("drops blank ids before deciding whether to query", async () => {
    const db = databaseWith(SAMPLE_CHAPTERS) as SqliteDb;
    expect(await bookWordCounts(db, ["   ", ""])).toEqual(new Map());
    expect(db.prepareCalls).toBe(0);
  });

  it("queries normally when a real id matches no book", async () => {
    const db = databaseWith(SAMPLE_CHAPTERS) as SqliteDb;
    expect(await bookWordCounts(db, ["book999"])).toEqual(new Map());
    expect(db.prepareCalls).toBeGreaterThan(0);
  });

  it("keeps paging inside every chunk", async () => {
    // A book past one page (500 rows) must not be truncated to that first page:
    // each chunk needs its own OFFSET walk, or 501 chapters would read as 500.
    const chapters = Array.from({length: 501}, () => ({
      _microfeed: {bookId: "book1"},
      description: "<p>一</p>",
    }));
    const db = databaseWith(chapters) as SqliteDb;
    const totals = await bookWordCounts(db, ["book1"]);
    expect(totals.get("book1")).toBe(501);
    // Two pages for 501 rows.
    expect(db.prepareCalls).toBe(2);
  });
});

describe("chunkWithinD1BindLimit", () => {
  it("splits so no chunk plus the reserved binds exceeds the cap", () => {
    const ids = Array.from({length: 300}, (_, i) => `book${i}`);
    const chunks = chunkWithinD1BindLimit(ids, 3);
    expect(chunks.flat()).toEqual(ids);
    for (const chunk of chunks) {
      expect(chunk.length + 3).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    }
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("gives no chunks for an empty list", () => {
    // The caller adds the single empty chunk that stands for the unscoped SQL.
    expect(chunkWithinD1BindLimit([])).toEqual([]);
  });

  it("never produces an oversized chunk even with no reserved binds", () => {
    const ids = Array.from({length: D1_MAX_BOUND_PARAMS + 5}, (_, i) => `book${i}`);
    for (const chunk of chunkWithinD1BindLimit(ids)) {
      expect(chunk.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    }
  });
});
