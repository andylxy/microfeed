import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {
  loadBookStatuses,
  saveBookStatuses,
} from "@/server/book-info/statuses";
import {
  listBookStatusesHandler,
  saveBookStatusesHandler,
} from "@/server/book-info/handlers";
import type {
  BookInfoDb,
  BookInfoDbPreparedStatement,
} from "@/server/book-info/types";
import type {BookInfoStatus} from "@/shared/BookInfo";

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

  async all() {
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
 * 内存库：镜像 `settings`（0001），供状态 IO 做端口级往返。状态读写吃
 * `D1Database`（`statuses.ts` 走 settings 通道），与 `groups.ts` 同构；测试把一个
 * SQLite 适配器投成 `D1Database`，不绑定真 D1。
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
  `);
  return new SqliteDb(database);
}

/** 直接塞一行 settings，绕过 saveBookStatuses 以构造「已存在却坏」的数据。 */
function seedRawSettings(db: SqliteDb, category: string, data: string): void {
  db.prepare("INSERT INTO settings (category, data) VALUES (?, ?)")
    .bind(category, data).run();
}

function asD1(db: SqliteDb): D1Database {
  return db as unknown as D1Database;
}

describe("book statuses IO (settings.book_info_statuses)", () => {
  it("falls back to an empty list when the settings row is missing", async () => {
    const db = emptyDatabase();
    expect(await loadBookStatuses(asD1(db))).toEqual([]);
  });

  it("round-trips save then load, sorted by sort then value", async () => {
    const db = emptyDatabase();
    const statuses: BookInfoStatus[] = [
      {value: 2, label: "会员", sort: 2},
      {value: 0, label: "公开", sort: 0},
      {value: 1, label: "隐藏", sort: 1},
    ];
    await saveBookStatuses(asD1(db), statuses);
    const loaded = await loadBookStatuses(asD1(db));
    expect(loaded.map((status) => status.value)).toEqual([0, 1, 2]);
  });

  it("overwrites the whole list on save (no merge with the previous list)", async () => {
    const db = emptyDatabase();
    await saveBookStatuses(asD1(db), [
      {value: 0, label: "公开", sort: 0},
      {value: 1, label: "隐藏", sort: 1},
    ]);
    await saveBookStatuses(asD1(db), [{value: 7, label: "会员", sort: 0}]);
    const loaded = await loadBookStatuses(asD1(db));
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.value).toBe(7);
  });

  it("throws fail-closed on a stored-but-malformed settings row", async () => {
    const db = emptyDatabase();
    // 已存在却不是 {statuses:[...]} 形状：不能静默吞成空（镜像 groups/parseCodes 口径）。
    seedRawSettings(db, "book_info_statuses", '{"statuses": "not-an-array"}');
    await expect(loadBookStatuses(asD1(db))).rejects.toThrow(/invalid_book_statuses/u);
  });

  it("falls back to empty on malformed JSON text", async () => {
    const db = emptyDatabase();
    seedRawSettings(db, "book_info_statuses", "not-json-at-all");
    expect(await loadBookStatuses(asD1(db))).toEqual([]);
  });
});

describe("book statuses handlers", () => {
  it("lists the statuses through the read handler", async () => {
    const db = emptyDatabase();
    await saveBookStatuses(asD1(db), [{value: 0, label: "公开", sort: 0}]);
    expect(await listBookStatusesHandler(asD1(db))).toEqual([
      {value: 0, label: "公开", sort: 0},
    ]);
  });

  it("refuses an empty status list with the lastStatus 400", async () => {
    const db = emptyDatabase();
    await expect(
      saveBookStatusesHandler(asD1(db), {statuses: []}),
    ).rejects.toMatchObject({status: 400, i18nKey: "errors.bookInfo.lastStatus"});
  });

  it("refuses a duplicate status value with a 400", async () => {
    const db = emptyDatabase();
    await expect(
      saveBookStatusesHandler(asD1(db), {
        statuses: [
          {value: 0, label: "公开", sort: 0},
          {value: 0, label: "重复值", sort: 1},
        ],
      }),
    ).rejects.toMatchObject({status: 400});
  });

  it("saves a valid list and returns it", async () => {
    const db = emptyDatabase();
    const result = await saveBookStatusesHandler(asD1(db), {
      statuses: [
        {value: 0, label: "公开", sort: 0},
        {value: 2, label: "会员", sort: 1},
      ],
    });
    expect(result.statuses).toHaveLength(2);
    expect((await loadBookStatuses(asD1(db))).map((status) => status.value))
      .toEqual([0, 2]);
  });
});
