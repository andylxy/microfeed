import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {SqliteStatement} from "./support/sqlite-statement";
import {
  createBookInfo,
  deleteBookInfo,
  getBookInfo,
  loadBookInfoBoard,
  purgeBookInfo,
  updateBookInfo,
} from "@/server/book-info/store";
import {
  bookInfoCreateSchema,
  bookInfoUpdateSchema,
  createBookInfoHandler,
  deleteBookInfoHandler,
  purgeBookInfoHandler,
} from "@/server/book-info/handlers";
import type {
  BookInfoDb,
  BookInfoDbPreparedStatement,
} from "@/server/book-info/types";
import {AppError} from "@/shared/errors";



class SqliteBookInfoDb implements BookInfoDb {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): BookInfoDbPreparedStatement {
    return new SqliteStatement(this.database, query);
  }
}

/** handler 的分组/状态 IO 吃 `D1Database`（settings 通道），测试投成同一形状。 */
function asD1(db: SqliteBookInfoDb): D1Database {
  return db as unknown as D1Database;
}

/** 镜像迁移 0001 + 0173 + 0176 的 DDL（0176 删了 `parent_id`/`org_id` 及
 *  自引用触发器），供端口级往返测试。`settings` 表必带：create/update handler
 *  会经 `loadBookStatuses` 走 settings 通道校验 `hot_book`，缺表会抛
 *  `no such table` 而非业务 400。 */
function emptyDatabase(): SqliteBookInfoDb {
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
      is_enable       INTEGER NOT NULL DEFAULT 1,
      comment         VARCHAR(255),
      created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at      TIMESTAMP,
      ext1 VARCHAR(255), ext2 VARCHAR(255), ext3 VARCHAR(255), ext4 VARCHAR(255), ext5 VARCHAR(255),
      ext6 VARCHAR(255), ext7 VARCHAR(255), ext8 VARCHAR(255), ext9 VARCHAR(255), ext10 VARCHAR(255)
    );
  `);
  return new SqliteBookInfoDb(database);
}

describe("book_info store round-trip", () => {
  it("creates, reads and lists a row", async () => {
    const db = emptyDatabase();
    const created = await createBookInfo(db, "bookinfo001", {
      bookName: "本草纲目",
      author: "李时珍",
      bookNo: "1",
      caseDivision: "总目",
      chengShu: "明万历",
      hotBook: 0,
      isEnable: true,
    });
    expect(created.id).toBe("bookinfo001");
    expect(created.bookName).toBe("本草纲目");
    expect(created.bookNo).toBe("1");
    expect(created.hotBook).toBe(0);
    expect(created.isEnable).toBe(true);
    expect(created.isDeleted).toBe(false);

    const loaded = await getBookInfo(db, created.id);
    expect(loaded?.bookName).toBe("本草纲目");
    expect(loaded?.author).toBe("李时珍");

    const board = await loadBookInfoBoard(db);
    expect(board).toHaveLength(1);
    expect(board[0]?.id).toBe(created.id);
  });

  it("updates with a partial patch and preserves untouched fields", async () => {
    const db = emptyDatabase();
    const created = await createBookInfo(db, "bookinfo002", {
      bookName: "伤寒论",
      bookNo: "2",
      caseDivision: "六经",
      author: "张仲景",
      hotBook: 0,
      isEnable: true,
    });
    const updated = await updateBookInfo(db, created.id, {
      bookName: "伤寒杂病论",
      isEnable: false,
    });
    expect(updated?.bookName).toBe("伤寒杂病论");
    expect(updated?.author).toBe("张仲景"); // 未 touch 的字段保留
    expect(updated?.isEnable).toBe(false);
    expect(updated?.isDeleted).toBe(false);
  });

  it("soft deletes then purges; purge refuses an un-deleted row", async () => {
    const db = emptyDatabase();
    const created = await createBookInfo(db, "bookinfo003", {
      bookName: "金匮要略",
      bookNo: "3",
      caseDivision: "杂病",
      hotBook: 0,
    });

    // 未软删 → 物删被拒
    await expect(purgeBookInfo(db, created.id)).resolves.toEqual({
      purged: false,
      reason: "notDeleted",
    });

    // 软删 → 行保留但 isDeleted
    expect(await deleteBookInfo(db, created.id)).toBe(true);
    const softDeleted = await getBookInfo(db, created.id);
    expect(softDeleted?.isDeleted).toBe(true);
    // 已软删不再重复软删
    expect(await deleteBookInfo(db, created.id)).toBe(false);

    // 物删
    await expect(purgeBookInfo(db, created.id)).resolves.toEqual({purged: true});
    expect(await getBookInfo(db, created.id)).toBeNull();
    await expect(purgeBookInfo(db, created.id)).resolves.toEqual({
      purged: false,
      reason: "missing",
    });
  });

  it("board flags a soft-deleted row so the UI can offer purge", async () => {
    const db = emptyDatabase();
    const created = await createBookInfo(db, "bookinfo004", {
      bookName: "温病条辨",
      bookNo: "4",
      caseDivision: "三焦",
      hotBook: 0,
    });
    await deleteBookInfo(db, created.id);
    const board = await loadBookInfoBoard(db);
    expect(board).toHaveLength(1);
    expect(board[0]?.isDeleted).toBe(true);
  });

  it("board sorts by book_name (text book_no no longer sorts numerically)", async () => {
    const db = emptyDatabase();
    // ASCII 书名：SQLite 默认 BINARY 排序按 UTF-8 字节序，与生产 D1 同口径。
    // book_no 故意乱序（2/10/9），证明排序键是 book_name 而非 book_no 的数值。
    await createBookInfo(db, "bookinfo002", {bookName: "Book-C", bookNo: "2", caseDivision: "分", hotBook: 0});
    await createBookInfo(db, "bookinfo001", {bookName: "Book-A", bookNo: "10", caseDivision: "分", hotBook: 0});
    await createBookInfo(db, "bookinfo003", {bookName: "Book-B", bookNo: "9", caseDivision: "分", hotBook: 0});
    const board = await loadBookInfoBoard(db);
    expect(board.map((row) => row.bookName)).toEqual(["Book-A", "Book-B", "Book-C"]);
  });
});

describe("bookInfo Zod schemas", () => {
  it("rejects a create payload with an empty name", () => {
    expect(
      bookInfoCreateSchema.safeParse({
        bookName: "",
        caseDivision: "分",
        bookNo: "1",
        hotBook: 0,
      }).success,
    ).toBe(false);
  });

  it("rejects a missing or non-integer hot book status (NOT NULL column)", () => {
    expect(
      bookInfoCreateSchema.safeParse({
        bookName: "书",
        caseDivision: "分",
        bookNo: "1",
      }).success,
    ).toBe(false);
    expect(
      bookInfoCreateSchema.safeParse({
        bookName: "书",
        caseDivision: "分",
        bookNo: "1",
        hotBook: null,
      }).success,
    ).toBe(false);
    expect(
      bookInfoCreateSchema.safeParse({
        bookName: "书",
        caseDivision: "分",
        bookNo: "1",
        hotBook: 1.5,
      }).success,
    ).toBe(false);
  });

  it("rejects an empty book number (text column, still required)", () => {
    expect(
      bookInfoCreateSchema.safeParse({
        bookName: "书",
        caseDivision: "分",
        bookNo: "",
        hotBook: 0,
      }).success,
    ).toBe(false);
  });

  it("accepts a full valid payload and trims text", () => {
    const parsed = bookInfoCreateSchema.safeParse({
      bookName: "  内经  ",
      author: "  佚名  ",
      caseDivision: " 养生 ",
      bookNo: " 9 ",
      caseTag: " 典籍 ",
      hotBook: 2,
      isEnable: false,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.bookName).toBe("内经");
      expect(parsed.data.caseDivision).toBe("养生");
      expect(parsed.data.bookNo).toBe("9");
      expect(parsed.data.hotBook).toBe(2);
      expect(parsed.data.isEnable).toBe(false);
    }
  });

  it("update schema makes every field optional but keeps non-null fields non-null", () => {
    const parsed = bookInfoUpdateSchema.safeParse({bookNo: "5"});
    expect(parsed.success).toBe(true);
    // 非空列更新时不可写成 null
    expect(
      bookInfoUpdateSchema.safeParse({bookName: null}).success,
    ).toBe(false);
    expect(
      bookInfoUpdateSchema.safeParse({bookNo: null}).success,
    ).toBe(false);
    expect(
      bookInfoUpdateSchema.safeParse({hotBook: null}).success,
    ).toBe(false);
  });
});

describe("book_info handlers", () => {
  it("delete handler 404s on a missing id", async () => {
    const db = emptyDatabase();
    await expect(
      deleteBookInfoHandler(db, "missing1"),
    ).rejects.toMatchObject({status: 404});
  });

  it("purge handler 409s on an un-deleted row and succeeds after soft delete", async () => {
    const db = emptyDatabase();
    const created = await createBookInfo(db, "bookinfo007", {
      bookName: "濒湖脉学",
      bookNo: "7",
      caseDivision: "分",
      hotBook: 0,
    });
    await expect(
      purgeBookInfoHandler(db, created.id),
    ).rejects.toMatchObject({status: 409, i18nKey: "errors.bookInfo.purgeNeedsDelete"});

    await deleteBookInfoHandler(db, created.id);
    await expect(purgeBookInfoHandler(db, created.id)).resolves.toEqual({
      purged: true,
    });
  });

  it("create handler rejects invalid input with AppError 400", async () => {
    const db = emptyDatabase();
    await expect(
      createBookInfoHandler(db, asD1(db), {bookName: ""}),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("create handler rejects a hot book value outside the status list (fail-closed on empty list)", async () => {
    const db = emptyDatabase();
    // 空 settings → 无状态清单 → 任何 hot_book 都拒（fail-closed）。
    await expect(
      createBookInfoHandler(db, asD1(db), {
        bookName: "书",
        caseDivision: "分",
        bookNo: "1",
        hotBook: 0,
      }),
    ).rejects.toMatchObject({status: 400, i18nKey: "errors.bookInfo.invalidStatus"});
  });
});
