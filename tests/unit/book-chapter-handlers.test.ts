import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {
  BOOK_CHAPTER_ERRORS,
  createBookChapterBodyHandler,
  createBookChapterHandler,
  deleteBookChapterBodyHandler,
  deleteBookChapterHandler,
  listBookChapterBodiesHandler,
  listBookChapterBoardHandler,
  purgeBookChapterBodyHandler,
  purgeBookChapterHandler,
  updateBookChapterBodyHandler,
  updateBookChapterHandler,
} from "@/server/book-chapter/handlers";
import type {
  BookChapterDb,
  BookChapterDbAllResult,
  BookChapterDbPreparedStatement,
} from "@/server/book-chapter/types";
// 建表/编辑 schema 真源在 shared（handlers 也从这里 import），测试直取真源。
import {
  bookChapterBodyCreateSchema,
  bookChapterCreateSchema,
} from "@/shared/BookChapter";
import {AppError} from "@/shared/errors";
import {ADMIN_MENU_CODES, PERMISSION_CODES} from "@/shared/Constants";

type SqlInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;

class SqliteStatement implements BookChapterDbPreparedStatement {
  private readonly statement: ReturnType<DatabaseSync["prepare"]>;
  private values: SqlInputValue[] = [];

  constructor(database: DatabaseSync, query: string) {
    this.statement = database.prepare(query);
  }

  bind(...values: unknown[]): BookChapterDbPreparedStatement {
    this.values = values as SqlInputValue[];
    return this;
  }

  async all(): Promise<BookChapterDbAllResult> {
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

class SqliteBookChapterDb implements BookChapterDb {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): BookChapterDbPreparedStatement {
    return new SqliteStatement(this.database, query);
  }
}

/** handler 的来源书下拉吃 `D1Database`（book_info 通道），测试投成同一形状。 */
function asD1(db: SqliteBookChapterDb): D1Database {
  return db as unknown as D1Database;
}

/** 镜像迁移 0181/0182 两表 + 0171 `book_info`（来源书下拉与分类归属）+
 *  `settings`（`book_groups` 清单，ADR-0063 三层树第一层）的 DDL。 */
function emptyDatabase(): SqliteBookChapterDb {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE settings (
      category VARCHAR(20) PRIMARY KEY,
      data TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE book_chapter (
      id                     VARCHAR(11) PRIMARY KEY,
      chapter_no             INTEGER NOT NULL,
      chapter_header         VARCHAR(255) NOT NULL,
      source_book_id         VARCHAR(11),
      source_book_name       VARCHAR(255),
      source_book_legacy_id  VARCHAR(64),
      source_chapter_legacy_id VARCHAR(64),
      chapter_section        VARCHAR(64),
      is_enable              INTEGER NOT NULL DEFAULT 1,
      signature_id           VARCHAR(64),
      signature              VARCHAR(64),
      created_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at             TIMESTAMP,
      ext1 VARCHAR(255), ext2 VARCHAR(255), ext3 VARCHAR(255), ext4 VARCHAR(255), ext5 VARCHAR(255),
      ext6 VARCHAR(255), ext7 VARCHAR(255), ext8 VARCHAR(255), ext9 VARCHAR(255), ext10 VARCHAR(255)
    );
    CREATE UNIQUE INDEX book_chapter_no_unique ON book_chapter (chapter_no);

    CREATE TABLE book_chapter_body (
      id              VARCHAR(11) PRIMARY KEY,
      book_chapter_id VARCHAR(11) NOT NULL,
      receipt_no      INTEGER NOT NULL,
      section_text    TEXT NOT NULL,
      section_note    TEXT,
      fang_ji         TEXT,
      fang_ji_zhujie  TEXT,
      bie_ming        TEXT,
      bencao_yao_name VARCHAR(64),
      bencao_level    VARCHAR(4),
      is_enable       INTEGER NOT NULL DEFAULT 1,
      signature_id    VARCHAR(64),
      signature       VARCHAR(64),
      created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at      TIMESTAMP,
      ext1 VARCHAR(255), ext2 VARCHAR(255), ext3 VARCHAR(255), ext4 VARCHAR(255), ext5 VARCHAR(255),
      ext6 VARCHAR(255), ext7 VARCHAR(255), ext8 VARCHAR(255), ext9 VARCHAR(255), ext10 VARCHAR(255)
    );
    CREATE INDEX book_chapter_body_chapter ON book_chapter_body (book_chapter_id);
    CREATE UNIQUE INDEX book_chapter_body_receipt ON book_chapter_body (book_chapter_id, receipt_no);

    CREATE TABLE book_info (
      id             VARCHAR(11) PRIMARY KEY,
      book_name      VARCHAR(255) NOT NULL,
      book_no        VARCHAR(64),
      case_division  VARCHAR(255) NOT NULL DEFAULT '',
      deleted_at     TIMESTAMP
    );
  `);
  database.exec(`
    INSERT INTO settings (category, data) VALUES (
      'book_groups',
      '{"groups":[{"key":"shanghan","label":"伤寒金匮","sort":0}]}'
    );
    INSERT INTO book_info (id, book_name, book_no, case_division)
      VALUES ('q6u5siNb2hT', '伤寒论・(宋版)', '10001', 'shanghan');
  `);
  return new SqliteBookChapterDb(database);
}

describe("bookChapter shared schema", () => {
  it("rejects a blank chapter header but keeps surrounding spaces", () => {
    expect(bookChapterCreateSchema.safeParse({chapterHeader: ""}).success).toBe(false);
    expect(bookChapterCreateSchema.safeParse({chapterHeader: "   "}).success).toBe(false);

    const parsed = bookChapterCreateSchema.safeParse({chapterHeader: "  刻仲景全书序  "});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.chapterHeader).toBe("  刻仲景全书序  ");
  });

  it("does not trim body text and requires section text", () => {
    expect(bookChapterBodyCreateSchema.safeParse({sectionText: ""}).success).toBe(false);

    const text = "        伤寒论世无善本。\r今夏得此本。  ";
    const parsed = bookChapterBodyCreateSchema.safeParse({sectionText: text});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.sectionText).toBe(text);
  });
});

describe("bookChapter permission wiring", () => {
  // 三镜像（Constants / rbac seed / 迁移 0182）里这一层最容易漂：
  // 权限码一旦与既有的 content:chapter:* / content:book:* 撞车，后台会互相顶掉。
  it("uses the dedicated content:book-chapter codes and the book_chapter menu", () => {
    expect(PERMISSION_CODES.CONTENT_BOOK_CHAPTER_READ).toBe("content:book-chapter:read");
    expect(PERMISSION_CODES.CONTENT_BOOK_CHAPTER_MANAGE).toBe("content:book-chapter:manage");
    expect(ADMIN_MENU_CODES.BOOK_CHAPTER).toBe("book_chapter");
    // 菜单码去掉 page_ 前缀即节点 id，侧栏靠它推导
    expect(`page_${ADMIN_MENU_CODES.BOOK_CHAPTER}`).toBe("page_book_chapter");
  });
});

describe("bookChapter handlers", () => {
  it("creates a chapter with a generated 11-char id and returns it in the board", async () => {
    const db = emptyDatabase();
    const created = await createBookChapterHandler(db, {
      chapterHeader: "辨太阳病脉证并治上",
      sourceBookId: "q6u5siNb2hT",
      chapterSection: "0",
    });
    expect(created.id).toHaveLength(11);
    expect(created.chapterNo).toBe(1);
    expect(created.chapterHeader).toBe("辨太阳病脉证并治上");

    const board = await listBookChapterBoardHandler(db, asD1(db));
    expect(board.chapters).toHaveLength(1);
    expect(board.sourceBooks).toEqual([
      {id: "q6u5siNb2hT", bookName: "伤寒论・(宋版)", bookNo: "10001", caseDivision: "shanghan"},
    ]);
  });

  it("returns the book_groups list and each book's caseDivision for the three-level tree", async () => {
    const db = emptyDatabase();
    const board = await listBookChapterBoardHandler(db, asD1(db));
    // 第一层分类来自 settings.book_groups，第二层书靠 caseDivision 归组（ADR-0063）。
    expect(board.groups).toEqual([
      {key: "shanghan", label: "伤寒金匮", sort: 0},
    ]);
    expect(board.sourceBooks[0]?.caseDivision).toBe("shanghan");
    expect(board.groups.some((group) => group.key === board.sourceBooks[0]?.caseDivision))
      .toBe(true);
  });

  it("rejects an invalid create payload with AppError 400", async () => {
    const db = emptyDatabase();
    await expect(createBookChapterHandler(db, {chapterHeader: "  "}))
      .rejects.toBeInstanceOf(AppError);
    await expect(createBookChapterHandler(db, {chapterHeader: ""}))
      .rejects.toMatchObject({
        status: 400,
        i18nKey: BOOK_CHAPTER_ERRORS.invalidInput,
      });
  });

  it("rejects an empty update patch and reports 404 for an unknown id", async () => {
    const db = emptyDatabase();
    const created = await createBookChapterHandler(db, {chapterHeader: "卷一"});

    await expect(updateBookChapterHandler(db, created.id, {}))
      .rejects.toMatchObject({
        status: 400,
        i18nKey: BOOK_CHAPTER_ERRORS.invalidInput,
      });

    await expect(updateBookChapterHandler(db, "nope0000000", {chapterHeader: "改"}))
      .rejects.toMatchObject({status: 404, i18nKey: BOOK_CHAPTER_ERRORS.notFound});
  });

  it("soft deletes, then purges; purge needs a prior soft delete", async () => {
    const db = emptyDatabase();
    const created = await createBookChapterHandler(db, {chapterHeader: "卷二"});

    await expect(purgeBookChapterHandler(db, created.id))
      .rejects.toMatchObject({
        status: 409,
        i18nKey: BOOK_CHAPTER_ERRORS.purgeNeedsDelete,
      });

    await expect(deleteBookChapterHandler(db, created.id)).resolves.toEqual({deleted: true});
    await expect(purgeBookChapterHandler(db, created.id)).resolves.toEqual({purged: true});
    await expect(deleteBookChapterHandler(db, created.id))
      .rejects.toMatchObject({status: 404, i18nKey: BOOK_CHAPTER_ERRORS.notFound});
  });

  it("refuses to purge a chapter that still has bodies", async () => {
    const db = emptyDatabase();
    const chapter = await createBookChapterHandler(db, {chapterHeader: "卷四"});
    await createBookChapterBodyHandler(db, chapter.id, {sectionText: "正文一条"});

    await expect(deleteBookChapterHandler(db, chapter.id)).resolves.toEqual({deleted: true});
    await expect(purgeBookChapterHandler(db, chapter.id))
      .rejects.toMatchObject({
        status: 409,
        i18nKey: BOOK_CHAPTER_ERRORS.purgeHasBodies,
      });
  });

  it("creates bodies under a chapter and lists them back", async () => {
    const db = emptyDatabase();
    const chapter = await createBookChapterHandler(db, {chapterHeader: "卷三"});

    const first = await createBookChapterBodyHandler(db, chapter.id, {
      sectionText: "太阳之为病，脉浮，头项强痛而恶寒。",
    });
    expect(first.id).toHaveLength(11);
    expect(first.receiptNo).toBe(1);
    expect(first.bookChapterId).toBe(chapter.id);

    const second = await createBookChapterBodyHandler(db, chapter.id, {
      sectionText: "  太阳病，发热汗出。\r  恶风，脉缓。  ",
    });
    // 文本原样入库，不被 trim
    expect(second.sectionText).toBe("  太阳病，发热汗出。\r  恶风，脉缓。  ");

    const listed = await listBookChapterBodiesHandler(db, chapter.id);
    expect(listed.bodies.map((body) => body.receiptNo)).toEqual([1, 2]);
    expect(listed.bodies[1]?.sectionText).toBe("  太阳病，发热汗出。\r  恶风，脉缓。  ");
  });

  it("rejects a body without section text", async () => {
    const db = emptyDatabase();
    const chapter = await createBookChapterHandler(db, {chapterHeader: "卷四"});
    await expect(createBookChapterBodyHandler(db, chapter.id, {sectionText: ""}))
      .rejects.toMatchObject({
        status: 400,
        i18nKey: BOOK_CHAPTER_ERRORS.invalidInput,
      });
  });

  it("updates and deletes a body; unknown body ids report 404", async () => {
    const db = emptyDatabase();
    const chapter = await createBookChapterHandler(db, {chapterHeader: "卷五"});
    const body = await createBookChapterBodyHandler(db, chapter.id, {sectionText: "旧文"});

    const updated = await updateBookChapterBodyHandler(db, body.id, {
      sectionText: "新文，带缩进。  ",
    });
    expect(updated.sectionText).toBe("新文，带缩进。  ");

    await expect(updateBookChapterBodyHandler(db, "nope0000000", {sectionText: "改"}))
      .rejects.toMatchObject({status: 404, i18nKey: BOOK_CHAPTER_ERRORS.notFound});

    await expect(purgeBookChapterBodyHandler(db, body.id))
      .rejects.toMatchObject({
        status: 409,
        i18nKey: BOOK_CHAPTER_ERRORS.purgeNeedsDelete,
      });

    await expect(deleteBookChapterBodyHandler(db, body.id)).resolves.toEqual({deleted: true});
    await expect(purgeBookChapterBodyHandler(db, body.id)).resolves.toEqual({purged: true});
  });
});
