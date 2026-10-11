import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {
  bookWordCounts,
  chapterWordCount,
  countBodyText,
  readBookStats,
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

  async run(): Promise<unknown> {
    return this.statement.run(...this.values);
  }
}

class SqliteDb implements WordCountDb {
  constructor(readonly raw: DatabaseSync) {}

  /** Number of statements prepared. Proves an early return skipped the query. */
  prepareCalls = 0;
  /** The SQL texts, in order, so a test can inspect what was emitted. */
  queries: string[] = [];

  prepare(query: string): WordCountDbPreparedStatement {
    this.prepareCalls += 1;
    this.queries.push(query);
    return new SqliteStatement(this.raw, query);
  }
}

function contentTextOf(chapter: Record<string, unknown>): string {
  if (typeof chapter.content_text === "string") return chapter.content_text;
  const description = chapter.description;
  return typeof description === "string" ? description.replace(/<[^>]+>/g, "") : "";
}

/** Mirrors `migrations/0103_ext_book_stats.sql`: the table plus the three
 *  invalidation triggers, so the tests exercise the real invalidation path. */
function databaseWith(chapters: Array<Record<string, unknown>>): SqliteDb {
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
    CREATE TABLE ext_book_stats (
      book_id            VARCHAR(11) PRIMARY KEY,
      chapters_published INTEGER NOT NULL DEFAULT 0,
      words_published    INTEGER NOT NULL DEFAULT 0,
      chapters_all       INTEGER NOT NULL DEFAULT 0,
      words_all          INTEGER NOT NULL DEFAULT 0,
      computed_at_ms     INTEGER NOT NULL DEFAULT 0
    );
    CREATE TRIGGER ext_book_stats_dirty_on_insert
    AFTER INSERT ON items
    BEGIN
      UPDATE ext_book_stats SET computed_at_ms = 0 WHERE book_id = NEW.book_id;
    END;
    CREATE TRIGGER ext_book_stats_dirty_on_update
    AFTER UPDATE ON items
    BEGIN
      UPDATE ext_book_stats SET computed_at_ms = 0
       WHERE book_id IN (OLD.book_id, NEW.book_id);
    END;
    CREATE TRIGGER ext_book_stats_dirty_on_delete
    AFTER DELETE ON items
    BEGIN
      UPDATE ext_book_stats SET computed_at_ms = 0 WHERE book_id = OLD.book_id;
    END;
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

function storedStats(db: SqliteDb): Array<Record<string, unknown>> {
  return db.raw
    .prepare("SELECT book_id, chapters_published, words_published, computed_at_ms FROM ext_book_stats ORDER BY book_id")
    .all() as Array<Record<string, unknown>>;
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
    const db = databaseWith(SAMPLE_CHAPTERS);
    expect((await bookWordCounts(db, ["book1"])).get("book1")).toBe(6);
  });

  it("omits books with no published chapters", async () => {
    // A book whose only chapters are drafts must not appear at all — that is
    // what "summed over its published chapters" meant before the cache existed.
    const db = databaseWith([
      {_microfeed: {bookId: "book1"}, description: "<p>草稿</p>", status: 2},
    ]);
    expect(await bookWordCounts(db, ["book1"])).toEqual(new Map());
  });

  it("returns nothing for an empty list without querying", async () => {
    const db = databaseWith(SAMPLE_CHAPTERS);
    expect(await bookWordCounts(db, [])).toEqual(new Map());
    expect(db.prepareCalls).toBe(0);
  });

  it("drops blank ids before deciding whether to query", async () => {
    const db = databaseWith(SAMPLE_CHAPTERS);
    expect(await bookWordCounts(db, ["   ", ""])).toEqual(new Map());
    expect(db.prepareCalls).toBe(0);
  });

  it("queries normally when a real id matches no book", async () => {
    const db = databaseWith(SAMPLE_CHAPTERS);
    expect(await bookWordCounts(db, ["book999"])).toEqual(new Map());
    expect(db.prepareCalls).toBeGreaterThan(0);
  });
});

describe("materialised stats", () => {
  it("reads the stats table instead of scanning items", async () => {
    // The whole point of 0103: 9,547 rows_read -> 12. The read path must touch
    // `ext_book_stats`, never `items`, once the numbers are stored.
    const db = databaseWith(SAMPLE_CHAPTERS);
    await bookWordCounts(db, ["book1"]);
    db.queries.length = 0;
    await bookWordCounts(db, ["book1"]);
    expect(db.queries.length).toBe(1);
    expect(db.queries[0]).toContain("ext_book_stats");
    expect(db.queries[0]).not.toContain("FROM items");
  });

  it("stores both published and all-rows counts in one pass", async () => {
    const db = databaseWith(SAMPLE_CHAPTERS);
    const stats = await readBookStats(db, ["book1"]);
    expect(stats.get("book1")).toMatchObject({
      chaptersPublished: 2,
      wordsPublished: 6,
      // The draft (草稿 = 2 chars) counts towards the dashboard's "all" pair only.
      chaptersAll: 3,
      wordsAll: 8,
    });
    expect(storedStats(db)).toContainEqual(expect.objectContaining({
      book_id: "book1",
      chapters_published: 2,
      words_published: 6,
    }));
  });

  it("self-heals a book whose stats row is missing", async () => {
    const db = databaseWith(SAMPLE_CHAPTERS);
    await bookWordCounts(db, ["book1"]);
    db.raw.prepare("DELETE FROM ext_book_stats").run();
    expect((await bookWordCounts(db, ["book1"])).get("book1")).toBe(6);
    expect(storedStats(db)).toHaveLength(1);
  });

  it("recomputes a book the trigger marked stale", async () => {
    const db = databaseWith(SAMPLE_CHAPTERS);
    expect((await bookWordCounts(db, ["book1"])).get("book1")).toBe(6);
    // Any items write marks that book stale — no application hook needed.
    db.raw.prepare("UPDATE items SET content_text = ? WHERE id = ?")
      .run("新正文", "chap0");
    expect(storedStats(db)[0]?.computed_at_ms).toBe(0);
    // 新正文 = 3 chars, 第二章 = 3 chars.
    expect((await bookWordCounts(db, ["book1"])).get("book1")).toBe(6);
    expect(storedStats(db)[0]?.computed_at_ms).not.toBe(0);
  });

  it("recomputes a book whose row was marked stale by a delete", async () => {
    const db = databaseWith(SAMPLE_CHAPTERS);
    expect((await bookWordCounts(db, ["book1"])).get("book1")).toBe(6);
    db.raw.prepare("DELETE FROM items WHERE id = ?").run("chap1");
    expect((await bookWordCounts(db, ["book1"])).get("book1")).toBe(3);
  });

  it("bootstraps the whole table when it is empty and unscoped", async () => {
    const db = databaseWith(SAMPLE_CHAPTERS);
    expect(await bookWordCounts(db)).toEqual(new Map([["book1", 6], ["book2", 3]]));
    expect(storedStats(db).map((row) => row.book_id)).toEqual(["book1", "book2"]);
  });
});
