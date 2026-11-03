import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {
  loadBookGroups,
  saveBookGroups,
} from "@/server/book-info/groups";
import {
  listBookGroupsHandler,
  reassignBookGroupHandler,
  saveBookGroupsHandler,
} from "@/server/book-info/handlers";
import {createBookInfo, reassignBookGroup} from "@/server/book-info/store";
import type {
  BookInfoDb,
  BookInfoDbAllResult,
  BookInfoDbPreparedStatement,
} from "@/server/book-info/types";
import type {BookInfoGroup} from "@/shared/BookInfo";

type SqlInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;

class SqliteStatement implements BookInfoDbPreparedStatement {
  private readonly statement: ReturnType<DatabaseSync["prepare"]>;
  private values: SqlInputValue[] = [];

  constructor(database: DatabaseSync, query: string) {
    this.statement = database.prepare(query);
  }

  bind(...values: unknown[]): BookInfoDbPreparedStatement {
    this.values = values as SqlInputValue[];
    return this;
  }

  async all(): Promise<BookInfoDbAllResult> {
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

/**
 * 内存库：镜像 `settings`（0001）与 `book_info`（0171）两张表，供分组 IO 与
 * 改派做端口级往返。分组读写吃 `D1Database`（`groups.ts` 走 settings 通道），
 * 书读写吃 `BookInfoDb`——两者都是「只暴露 prepare」的同一形状，一个适配器
 * 同时满足（ADR-0059 决策 5：两侧 db 在调用方是同一个 `env.FEED_DB`）。
 */
class SqliteDb implements BookInfoDb {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): BookInfoDbPreparedStatement {
    return new SqliteStatement(this.database, query);
  }
}

function emptyDatabase(): SqliteDb {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE settings (
      category VARCHAR(20) PRIMARY KEY,
      data TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE book_info (
      id              VARCHAR(11) PRIMARY KEY,
      book_name       VARCHAR(255) NOT NULL,
      chapter         INTEGER,
      author          VARCHAR(255),
      cheng_shu       VARCHAR(255),
      case_division   VARCHAR(255) NOT NULL,
      case_tag        TEXT NOT NULL DEFAULT '',
      book_no         TEXT NOT NULL DEFAULT '',
      image_url       VARCHAR(255),
      hot_book        INTEGER NOT NULL DEFAULT 0,
      parent_id       VARCHAR(11),
      org_id          INTEGER,
      is_enable       INTEGER NOT NULL DEFAULT 1,
      comment         VARCHAR(255),
      created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at      TIMESTAMP
    );
  `);
  return new SqliteDb(database);
}

/** 直接塞一行 settings，绕过 saveBookGroups 以构造「已存在却坏」的数据。 */
function seedRawSettings(db: SqliteDb, category: string, data: string): void {
  db.prepare("INSERT INTO settings (category, data) VALUES (?, ?)")
    .bind(category, data).run();
}

/**
 * 分组 IO（`groups.ts`/`settings-store.ts`）吃 `D1Database`，书 IO（`store.ts`）
 * 吃 `BookInfoDb`。生产端两者是同一个 `env.FEED_DB`（ajax 层
 * `env.FEED_DB as unknown as D1Database`），测试同理把一个 SQLite 适配器分别
 * 投成两侧端口，保证形状一致、不绑定真 D1。
 */
function asD1(db: SqliteDb): D1Database {
  return db as unknown as D1Database;
}

describe("book groups IO (settings.book_groups)", () => {
  it("falls back to an empty list when the settings row is missing", async () => {
    const db = emptyDatabase();
    expect(await loadBookGroups(asD1(db))).toEqual([]);
  });

  it("round-trips save then load, sorted by sort then key", async () => {
    const db = emptyDatabase();
    const groups: BookInfoGroup[] = [
      {key: "bencao", label: "本草", sort: 2},
      {key: "shanghan", label: "伤寒金匮", sort: 0},
      {key: "neijing", label: "内经", sort: 1},
    ];
    await saveBookGroups(asD1(db), groups);
    const loaded = await loadBookGroups(asD1(db));
    expect(loaded.map((group) => group.key)).toEqual(["shanghan", "neijing", "bencao"]);
  });

  it("overwrites the whole list on save (no merge with the previous list)", async () => {
    const db = emptyDatabase();
    await saveBookGroups(asD1(db), [
      {key: "shanghan", label: "伤寒金匮", sort: 0},
      {key: "bencao", label: "本草", sort: 1},
    ]);
    await saveBookGroups(asD1(db), [{key: "neijing", label: "内经", sort: 0}]);
    const loaded = await loadBookGroups(asD1(db));
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.key).toBe("neijing");
  });

  it("throws fail-closed on a stored-but-malformed settings row", async () => {
    const db = emptyDatabase();
    // 已存在却不是 {groups:[...]} 形状：不能静默吞成空（镜像 parseCodes 口径）。
    seedRawSettings(db, "book_groups", '{"groups": "not-an-array"}');
    await expect(loadBookGroups(asD1(db))).rejects.toThrow(/invalid_book_groups/u);
  });

  it("falls back to empty on malformed JSON text", async () => {
    const db = emptyDatabase();
    seedRawSettings(db, "book_groups", "not-json-at-all");
    expect(await loadBookGroups(asD1(db))).toEqual([]);
  });
});

describe("book groups handlers", () => {
  it("lists the groups through the read handler", async () => {
    const db = emptyDatabase();
    await saveBookGroups(asD1(db), [{key: "bencao", label: "本草", sort: 0}]);
    expect(await listBookGroupsHandler(asD1(db))).toEqual([
      {key: "bencao", label: "本草", sort: 0},
    ]);
  });

  it("refuses an empty group list with the lastGroup 400", async () => {
    const db = emptyDatabase();
    await expect(
      saveBookGroupsHandler(asD1(db), {groups: []}),
    ).rejects.toMatchObject({status: 400, i18nKey: "errors.bookInfo.lastGroup"});
  });

  it("refuses a duplicate group key with a 400", async () => {
    const db = emptyDatabase();
    await expect(
      saveBookGroupsHandler(asD1(db), {
        groups: [
          {key: "shanghan", label: "伤寒金匮", sort: 0},
          {key: "shanghan", label: "重复键", sort: 1},
        ],
      }),
    ).rejects.toMatchObject({status: 400});
  });

  it("saves a valid list and returns it", async () => {
    const db = emptyDatabase();
    const result = await saveBookGroupsHandler(asD1(db), {
      groups: [
        {key: "shanghan", label: "伤寒金匮", sort: 0},
        {key: "bencao", label: "本草", sort: 1},
      ],
    });
    expect(result.groups).toHaveLength(2);
    expect((await loadBookGroups(asD1(db))).map((group) => group.key))
      .toEqual(["shanghan", "bencao"]);
  });
});

describe("book group reassignment", () => {
  it("moves every book of the from-group to the to-group", async () => {
    const db = emptyDatabase();
    await createBookInfo(db, "bookinfo001", {bookName: "伤寒论", bookNo: "1", caseDivision: "shanghan", hotBook: 0});
    await createBookInfo(db, "bookinfo002", {bookName: "本草纲目", bookNo: "2", caseDivision: "shanghan", hotBook: 0});
    await createBookInfo(db, "bookinfo003", {bookName: "内经", bookNo: "3", caseDivision: "neijing", hotBook: 0});

    await reassignBookGroup(db, "shanghan", "bencao");

    const board = await db.prepare("SELECT case_division FROM book_info ORDER BY id ASC").all();
    expect(board.results.map((row) => row.case_division))
      .toEqual(["bencao", "bencao", "neijing"]);
  });

  it("reassign handler rejects from === to", async () => {
    const db = emptyDatabase();
    await expect(
      reassignBookGroupHandler(db, {from: "shanghan", to: "shanghan"}),
    ).rejects.toMatchObject({status: 400});
  });

  it("reassign handler rejects an empty group key", async () => {
    const db = emptyDatabase();
    await expect(
      reassignBookGroupHandler(db, {from: "", to: "bencao"}),
    ).rejects.toMatchObject({status: 400});
  });

  it("reassign handler moves the books and is idempotent when none match", async () => {
    const db = emptyDatabase();
    await createBookInfo(db, "bookinfo004", {bookName: "金匮要略", bookNo: "4", caseDivision: "shanghan", hotBook: 0});
    await reassignBookGroupHandler(db, {from: "shanghan", to: "bencao"});
    const row = await db.prepare("SELECT case_division FROM book_info WHERE id = 'bookinfo004'").first();
    expect(row?.case_division).toBe("bencao");
    // 再改派一次：没有 shanghan 行了，UPDATE 影响 0 行，不报错。
    await expect(
      reassignBookGroupHandler(db, {from: "shanghan", to: "neijing"}),
    ).resolves.toEqual({reassigned: true});
  });
});
