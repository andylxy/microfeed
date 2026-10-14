import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {
  getBookVolumes,
  getTcmBookEntries,
  getVolumeSections,
  listCategoryNav,
  listChannelsByGenre,
  listPublishedBookSamples,
  searchPublishedBooks,
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
      ('yao_other', '{"title":"别的书的药","_microfeed":{"no":2}}', 1, '2024-09-14T16:56:57.000Z', 'book_other', 'yao', NULL),
      ('chapter_root_yao', '{"title":"中药"}', 1, '2024-09-14T16:56:57.000Z', 'book_yao', 'chapter', NULL),
      ('chapter_del', '{"title":"只剩已删条文"}', 1, '2024-09-14T16:56:57.000Z', 'book_del', 'chapter', NULL),
      ('section_del', '{"title":"已删条文"}', 3, '2024-09-14T16:56:57.000Z', 'book_del', 'section', 'chapter_del'),
      ('chapter_gone', '{"title":"已删篇章"}', 3, '2024-09-14T16:56:57.000Z', 'book_del', 'chapter', NULL),
      ('chapter_empty', '{"title":"条文删光了的活篇章"}', 1, '2024-09-14T16:56:57.000Z', 'book_del', 'chapter', NULL),
      ('section_empty', '{"title":"已删条文"}', 3, '2024-09-14T16:56:57.000Z', 'book_del', 'section', 'chapter_empty');
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

describe("getBookVolumes (ADR-0025 D2)", () => {
  it("returns the 篇章 rows of a book that actually holds 条文", async () => {
    const volumes = await getBookVolumes(databaseWithTcmItems(), "book_tcm");

    expect(volumes).toEqual([{id: "chapter_1", name: "平脉法第一"}]);
  });

  it("returns nothing for a flat book, whose root 篇章 carries no 条文", async () => {
    // 中药 / 名词 collections hang off a root 篇章 (title = the book's own name)
    // that holds no 条文. Treating that row as a volume would render a
    // one-volume catalog and drop the book's flat entries — it must not be
    // returned (ADR-0025 D2).
    expect(await getBookVolumes(databaseWithTcmItems(), "book_yao")).toEqual([]);
  });

  it("returns nothing for a book with no 篇章 at all", async () => {
    expect(await getBookVolumes(databaseWithTcmItems(), "book_other")).toEqual([]);
  });

  it("returns nothing when the book's only 条文 are deleted", async () => {
    // 探针带 `status != DELETED`：只剩已删条文的书不算结构化书，否则书页会列出一个
    // 打开即空的卷（`getVolumeSections` 也会返回 0 条）。
    expect(await getBookVolumes(databaseWithTcmItems(), "book_del")).toEqual([]);
  });
});

describe("getVolumeSections (ADR-0025 D1/D3 的卷页数据源)", () => {
  it("returns one 篇章 plus its 条文, stamped with the volume's id and name", async () => {
    const volume = await getVolumeSections(
      databaseWithTcmItems(),
      "chapter_1",
      "https://example.test",
    );

    expect(volume).toMatchObject({id: "chapter_1", name: "平脉法第一"});
    expect(volume?.sections.map((s: any) => s.id)).toEqual(["section_1"]);
    // 卷页的「返回」锚点与 prev/next 都依赖这两个键。
    expect(volume?.sections[0]?._microfeed).toMatchObject({
      chapterId: "chapter_1",
      volume: "平脉法第一",
    });
  });

  it("returns null for an id that is not a live 篇章, so the route can 404", async () => {
    const db = databaseWithTcmItems();
    expect(await getVolumeSections(db, "nope", "https://example.test")).toBeNull();
    // 方剂行、条文行都不是篇章
    expect(await getVolumeSections(db, "fang_1", "https://example.test")).toBeNull();
    expect(await getVolumeSections(db, "section_1", "https://example.test")).toBeNull();
    // 已删篇章（`status = 3`）—— 路由据此 404
    expect(await getVolumeSections(db, "chapter_gone", "https://example.test")).toBeNull();
  });

  it("returns a live 篇章 with 0 条文 rather than null (route shows 本卷暂无内容, not a 404)", async () => {
    // 篇章本身 `status=1`、只是条文已删：`getVolumeSections` 返回该卷 + 空数组。
    // 全书级点查不拦这种情况，所以书页仍列该卷、卷页 200 显示「本卷暂无内容」。
    const volume = await getVolumeSections(
      databaseWithTcmItems(),
      "chapter_empty",
      "https://example.test",
    );

    expect(volume).toMatchObject({id: "chapter_empty", name: "条文删光了的活篇章"});
    expect(volume?.sections).toEqual([]);
  });
});
