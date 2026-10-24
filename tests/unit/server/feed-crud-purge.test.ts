import {DatabaseSync} from "node:sqlite";
import {describe, expect, it, vi} from "vitest";

import FeedCrudManager from "@/server/feed/FeedCrudManager";

// 模块级 spy：观测分派目标（桶函数在 Workers 测试池外不可用，node:sqlite
// 单测环境里 caches.default 不存在——mock 掉桶函数只观测调用形状）。
vi.mock("@/server/cache/app-cache", () => ({
  purgeAppChapterContentCache: vi.fn(async () => undefined),
  purgeAppBookFangCache: vi.fn(async () => undefined),
  purgeAppYaoCache: vi.fn(async () => undefined),
}));

import {
  purgeAppChapterContentCache,
  purgeAppYaoCache,
} from "@/server/cache/app-cache";

/**
 * App 桶分派的时序与归属（ADR-0049 D5）：collect 模式（statements 缓冲、
 * 调用方稍后提交）在缓冲期不分派；提交后调用 `purgeAppContentCaches` 按
 * 提交后的行归属分派——条文改挂新章时清**新**章所属桶并清中药两桶。
 */
type SqlInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;

class SqliteStatement {
  private values: SqlInputValue[] = [];
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
  ) {}
  bind(...values: unknown[]): SqliteStatement {
    this.values = values as SqlInputValue[];
    return this;
  }
  async all() {
    return {
      results: this.database.prepare(this.sql).all(...this.values) as
        Record<string, unknown>[],
      success: true,
    };
  }
  async first() {
    return (this.database.prepare(this.sql).get(...this.values) as
      | Record<string, unknown>
      | undefined) ?? null;
  }
  async run() {
    this.database.prepare(this.sql).run(...this.values);
    return {results: [], success: true};
  }
}

function makeCrud(database: DatabaseSync): FeedCrudManager {
  const feedDb = {
    FEED_DB: {
      prepare(sql: string) {
        return new SqliteStatement(database, sql);
      },
      batch: async () => ({results: [], success: true}),
    },
    // saveInternalItem 经 putContent 写行：collect 模式下它把语句交给 commit
    // 回调缓冲（真批次由调用方执行）。假件按真实契约调用回调，令缓冲可见。
    putContent: async (
      _feed: unknown,
      commit?: (statements: unknown[]) => Promise<void>,
    ) => {
      await commit?.([]);
    },
  };
  return new FeedCrudManager({}, feedDb, undefined);
}

function newDb(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      status INTEGER,
      data TEXT,
      tcm_kind TEXT,
      tcm_parent_id TEXT
    );
  `);
  return database;
}

describe("purgeAppContentCaches ordering and dispatch (ADR-0049 D5)", () => {
  it("does not dispatch during collect buffering", async () => {
    const database = newDb();
    const crud = makeCrud(database);
    const buffered: unknown[][] = [];
    const collect = async (batch: unknown[]) => {
      buffered.push(batch);
    };

    // 行尚不存在（createItem 场景：提交前行不在库）——saveInternalItem 走
    // collect 模式，此刻不做任何分派（旧实现会在缓冲期空转读库）。
    await crud.saveInternalItem({id: "chap0000001", title: "章"}, collect);
    expect(buffered.length).toBe(1);
    expect(vi.mocked(purgeAppChapterContentCache)).not.toHaveBeenCalled();
  });

  it("dispatches by the committed row: a moved section clears its new chapter", async () => {
    const database = newDb();
    const crud = makeCrud(database);
    // 提交后的最终状态：条文挂在 chapNEW 下（改挂后的新归属）。
    database.prepare(
      "INSERT INTO items (id, status, data, tcm_kind, tcm_parent_id) " +
        "VALUES ('sect0000001', 1, '{}', 'section', 'chapNEW00001')",
    ).run();

    await crud.purgeAppContentCaches("sect0000001");
    expect(vi.mocked(purgeAppChapterContentCache))
      .toHaveBeenCalledWith("chapNEW00001");
    expect(vi.mocked(purgeAppYaoCache)).toHaveBeenCalledTimes(1);
  });
});
