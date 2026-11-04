import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {
  countBodiesByChapter,
  createBookChapter,
  createBookChapterBody,
  getBookChapter,
  getBookChapterBody,
  listBodiesByChapter,
  loadBookChapterBoard,
  purgeBookChapter,
  purgeBookChapterBody,
  softDeleteBookChapter,
  softDeleteBookChapterBody,
  updateBookChapter,
  updateBookChapterBody,
} from "@/server/book-chapter/store";
import type {
  BookChapterDb,
  BookChapterDbAllResult,
  BookChapterDbPreparedStatement,
} from "@/server/book-chapter/types";

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

/** 镜像迁移 0182 的两表 DDL（含 UNIQUE(chapter_no)），供端口级往返测试。 */
function emptyDatabase(): SqliteBookChapterDb {
  const database = new DatabaseSync(":memory:");
  database.exec(`
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
  `);
  return new SqliteBookChapterDb(database);
}

describe("book_chapter store round-trip", () => {
  it("creates, reads and lists a chapter; chapter_no is MAX+1", async () => {
    const db = emptyDatabase();
    const created = await createBookChapter(db, "chapter0001", {
      chapterHeader: "辨太阳病脉证并治上",
      sourceBookId: "q6u5siNb2hT",
      sourceBookName: "伤寒论・(宋版)",
      chapterSection: "0",
      isEnable: true,
    });
    expect(created.id).toBe("chapter0001");
    expect(created.chapterNo).toBe(1); // 空表 → MAX+1 = 1
    expect(created.chapterHeader).toBe("辨太阳病脉证并治上");
    expect(created.sourceBookId).toBe("q6u5siNb2hT");
    expect(created.isEnable).toBe(true);
    expect(created.isDeleted).toBe(false);

    const loaded = await getBookChapter(db, created.id);
    expect(loaded?.chapterHeader).toBe("辨太阳病脉证并治上");

    const board = await loadBookChapterBoard(db);
    expect(board).toHaveLength(1);
    expect(board[0]?.id).toBe(created.id);
  });

  it("next chapter_no continues after a seeded max", async () => {
    const db = emptyDatabase();
    await db.prepare(
      "INSERT INTO book_chapter (id, chapter_no, chapter_header) VALUES (?, ?, ?)",
    ).bind("seedmax001", 445, "种子卷章").run();
    const created = await createBookChapter(db, "chapter0002", {
      chapterHeader: "新卷章",
    });
    expect(created.chapterNo).toBe(446);
  });

  it("keeps a chapter header with leading and trailing spaces untouched", async () => {
    const db = emptyDatabase();
    // 源 ChapterHeader 实测 6 行前导空格 / 4 行行尾空格，都是内容。
    const header = "   刻仲景全书序  ";
    const created = await createBookChapter(db, "chapter0003", {chapterHeader: header});
    expect(created.chapterHeader).toBe(header);

    const loaded = await getBookChapter(db, created.id);
    expect(loaded?.chapterHeader).toBe(header);
  });

  it("updates with a partial patch and preserves untouched fields", async () => {
    const db = emptyDatabase();
    const created = await createBookChapter(db, "chapter0004", {
      chapterHeader: "金匮要略",
      sourceBookId: "Kcb7X2K5LTh",
      sourceBookName: "金匮要略・(人纪)",
      chapterSection: "4001001",
      isEnable: true,
    });
    const updated = await updateBookChapter(db, created.id, {
      chapterHeader: "金匮要略方论",
      isEnable: false,
    });
    expect(updated?.chapterHeader).toBe("金匮要略方论");
    expect(updated?.sourceBookId).toBe("Kcb7X2K5LTh"); // 未 touch 的字段保留
    expect(updated?.chapterSection).toBe("4001001");
    expect(updated?.isEnable).toBe(false);
    expect(updated?.isDeleted).toBe(false);
  });

  it("update clears a nullable field when the patch explicitly passes null", async () => {
    const db = emptyDatabase();
    const created = await createBookChapter(db, "chapter0005", {
      chapterHeader: "难经",
      sourceBookId: "tZYk25WiJ0R",
    });
    const updated = await updateBookChapter(db, created.id, {
      sourceBookId: null, // 显式清空
    });
    expect(updated?.sourceBookId).toBeNull();
  });

  it("soft deletes then purges; purge refuses an un-deleted row", async () => {
    const db = emptyDatabase();
    const created = await createBookChapter(db, "chapter0006", {
      chapterHeader: "素问",
    });

    // 未软删直接物删 → notDeleted
    const refused = await purgeBookChapter(db, created.id);
    expect(refused.purged).toBe(false);
    if (!refused.purged) expect(refused.reason).toBe("notDeleted");

    expect(await softDeleteBookChapter(db, created.id)).toBe(true);
    // 重复软删返回 false
    expect(await softDeleteBookChapter(db, created.id)).toBe(false);

    const after = await getBookChapter(db, created.id);
    expect(after?.isDeleted).toBe(true);

    const purged = await purgeBookChapter(db, created.id);
    expect(purged.purged).toBe(true);
    expect(await getBookChapter(db, created.id)).toBeNull();
  });

  it("purge reports missing for an unknown id", async () => {
    const db = emptyDatabase();
    const result = await purgeBookChapter(db, "nope0000000");
    expect(result.purged).toBe(false);
    if (!result.purged) expect(result.reason).toBe("missing");
  });

  it("purge refuses while the chapter still has bodies (no orphan rows)", async () => {
    const db = emptyDatabase();
    const chapter = await createBookChapter(db, "chapter0010", {
      chapterHeader: "平脉法",
    });
    const body = await createBookChapterBody(db, "body0000010", chapter.id, {
      sectionText: "问曰：脉有三部。",
    });

    expect(await softDeleteBookChapter(db, chapter.id)).toBe(true);
    const refused = await purgeBookChapter(db, chapter.id);
    expect(refused.purged).toBe(false);
    if (!refused.purged) expect(refused.reason).toBe("hasBodies");
    // 卷章还在，正文引用不悬空
    expect(await getBookChapter(db, chapter.id)).not.toBeNull();
    expect(await getBookChapterBody(db, body.id)).not.toBeNull();

    // 删掉正文后卷章才能物删
    expect(await softDeleteBookChapterBody(db, body.id)).toBe(true);
    expect((await purgeBookChapterBody(db, body.id)).purged).toBe(true);
    expect((await purgeBookChapter(db, chapter.id)).purged).toBe(true);
  });

  it("chapter_no is unique: a conflict on the same MAX+1 fails fast", async () => {
    const db = emptyDatabase();
    const first = await createBookChapter(db, "chapter0011", {
      chapterHeader: "卷一",
    });
    // 手工插入同 no（绕过 MAX+1），验证 UNIQUE 约束兜底。
    await expect(
      db.prepare(
        "INSERT INTO book_chapter (id, chapter_no, chapter_header) VALUES (?, ?, ?)",
      ).bind("chapter0012", first.chapterNo, "撞号").run(),
    ).rejects.toThrow(/UNIQUE/u);
  });
});

describe("book_chapter_body store round-trip", () => {
  it("creates a body with receipt_no MAX+1 within its chapter", async () => {
    const db = emptyDatabase();
    const chapter = await createBookChapter(db, "chapter1001", {chapterHeader: "卷一"});
    const first = await createBookChapterBody(db, "body0000001", chapter.id, {
      sectionText: "太阳之为病，脉浮，头项强痛而恶寒。",
      isEnable: true,
    });
    expect(first.receiptNo).toBe(1);
    expect(first.bookChapterId).toBe(chapter.id);
    expect(first.sectionText).toBe("太阳之为病，脉浮，头项强痛而恶寒。");
    expect(first.isDeleted).toBe(false);

    const second = await createBookChapterBody(db, "body0000002", chapter.id, {
      sectionText: "太阳病，发热，汗出，恶风，脉缓者，名为中风。",
    });
    expect(second.receiptNo).toBe(2);

    // receipt_no 按卷章隔离：另一卷章从 1 起
    const other = await createBookChapter(db, "chapter1002", {chapterHeader: "卷二"});
    const otherFirst = await createBookChapterBody(db, "body0000003", other.id, {
      sectionText: "别的卷章正文",
    });
    expect(otherFirst.receiptNo).toBe(1);
  });

  it("round-trips text byte-for-byte (no trim, no newline folding, no CR loss)", async () => {
    const db = emptyDatabase();
    const chapter = await createBookChapter(db, "chapter1003", {chapterHeader: "本草"});
    // 源数据真实形态：字面 CR + 前导缩进 + 句号后空格 + 行尾空格 + 真实换行。
    const sectionText = "        伤寒论世无善本。余所藏治平官刊大字景写本。\r今夏得此本。  \n        北宋人官刻经注皆大字。 ";
    const sectionNote = "  注：此条见《千金方》。  \n  又见《外台秘要》。 ";
    const created = await createBookChapterBody(db, "body0000004", chapter.id, {
      sectionText,
      sectionNote,
    });
    // 写入即保真
    expect(created.sectionText).toBe(sectionText);
    expect(created.sectionNote).toBe(sectionNote);
    expect(created.sectionText).toContain("\r");
    expect(created.sectionText).toContain("\n");

    // 读回仍逐字节一致
    const loaded = await getBookChapterBody(db, created.id);
    expect(loaded?.sectionText).toBe(sectionText);
    expect(loaded?.sectionNote).toBe(sectionNote);
  });

  it("update keeps text untouched when the patch does not carry it", async () => {
    const db = emptyDatabase();
    const chapter = await createBookChapter(db, "chapter1004", {chapterHeader: "卷三"});
    const text = "  原文带缩进与换行。\n第二行。  ";
    const created = await createBookChapterBody(db, "body0000005", chapter.id, {
      sectionText: text,
      isEnable: true,
    });
    const updated = await updateBookChapterBody(db, created.id, {isEnable: false});
    expect(updated?.isEnable).toBe(false);
    expect(updated?.sectionText).toBe(text); // 未被改写
  });

  it("update overwrites text verbatim when supplied", async () => {
    const db = emptyDatabase();
    const chapter = await createBookChapter(db, "chapter1005", {chapterHeader: "卷四"});
    const created = await createBookChapterBody(db, "body0000006", chapter.id, {
      sectionText: "旧文",
    });
    const next = "  新文第一行。\r\n  新文第二行。  ";
    const updated = await updateBookChapterBody(db, created.id, {sectionText: next});
    expect(updated?.sectionText).toBe(next);
  });

  it("lists bodies by chapter ordered by receipt_no", async () => {
    const db = emptyDatabase();
    const chapter = await createBookChapter(db, "chapter1006", {chapterHeader: "卷五"});
    const other = await createBookChapter(db, "chapter1007", {chapterHeader: "卷六"});
    await createBookChapterBody(db, "body0000010", chapter.id, {receiptNo: 2, sectionText: "第二条"});
    await createBookChapterBody(db, "body0000011", chapter.id, {receiptNo: 1, sectionText: "第一条"});
    await createBookChapterBody(db, "body0000012", other.id, {receiptNo: 1, sectionText: "别的卷"});

    const bodies = await listBodiesByChapter(db, chapter.id);
    expect(bodies.map((body) => body.sectionText)).toEqual(["第一条", "第二条"]);
    expect(bodies.every((body) => body.bookChapterId === chapter.id)).toBe(true);

    expect(await countBodiesByChapter(db, chapter.id)).toBe(2);
  });

  it("soft deletes then purges a body; purge refuses an un-deleted row", async () => {
    const db = emptyDatabase();
    const chapter = await createBookChapter(db, "chapter1008", {chapterHeader: "卷七"});
    const created = await createBookChapterBody(db, "body0000020", chapter.id, {
      sectionText: "待删正文",
    });

    const refused = await purgeBookChapterBody(db, created.id);
    expect(refused.purged).toBe(false);
    if (!refused.purged) expect(refused.reason).toBe("notDeleted");

    expect(await softDeleteBookChapterBody(db, created.id)).toBe(true);
    expect(await softDeleteBookChapterBody(db, created.id)).toBe(false);

    const after = await getBookChapterBody(db, created.id);
    expect(after?.isDeleted).toBe(true);

    const purged = await purgeBookChapterBody(db, created.id);
    expect(purged.purged).toBe(true);
    expect(await getBookChapterBody(db, created.id)).toBeNull();
  });

  it("keeps bencao columns null on create (import-derived, admin does not edit)", async () => {
    const db = emptyDatabase();
    const chapter = await createBookChapter(db, "chapter1009", {chapterHeader: "本草经"});
    const created = await createBookChapterBody(db, "body0000030", chapter.id, {
      sectionText: "丹砂，味甘，微寒。",
      bieMing: "丹砂,朱砂",
    });
    // 派生列不随表单写入：只由导入脚本产生
    expect(created.bieMing).toBe("丹砂,朱砂");
    expect(created.bencaoYaoName).toBeNull();
    expect(created.bencaoLevel).toBeNull();
  });
});
