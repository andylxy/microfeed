import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {
  countChannelsByStatus,
  createBookStatus,
  deleteBookStatus,
  listAdminListHiddenCodes,
  listBookStatusRows,
  listFormSelectableStatusCodes,
  listPublicVisibleStatusCodes,
  nextBookStatusCode,
  updateBookStatus,
  type BookStatusDb,
  type BookStatusDbAllResult,
  type BookStatusDbPreparedStatement,
} from "@/server/feed/extBookStatus";
import {
  createBookStatusHandler,
  deleteBookStatusHandler,
  updateBookStatusHandler,
} from "@/server/admin/book-status-handlers";
import {AppError} from "@/shared/errors";
import {BOOK_STATUS_COLOR_PATTERN} from "@/shared/ExtBook";

type SqlInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;

class SqliteStatement implements BookStatusDbPreparedStatement {
  private readonly statement: ReturnType<DatabaseSync["prepare"]>;
  private values: SqlInputValue[] = [];

  constructor(database: DatabaseSync, query: string) {
    this.statement = database.prepare(query);
  }

  bind(...values: unknown[]): BookStatusDbPreparedStatement {
    this.values = values as SqlInputValue[];
    return this;
  }

  async all(): Promise<BookStatusDbAllResult> {
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

class SqliteBookStatusDb implements BookStatusDb {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): BookStatusDbPreparedStatement {
    return new SqliteStatement(this.database, query);
  }
}

const SYSTEM_SEED = `
  (1, '显示', 'Visible', 1, 1, 0, 1, 100),
  (2, '隐藏', 'Hidden', 1, 0, 0, 1, 200),
  (3, '已删除', 'Deleted', 0, 0, 1, 1, 300);
`;

function database(options: {seed?: boolean; channels?: boolean} = {}): SqliteBookStatusDb {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE ext_book_status (
      code              INTEGER PRIMARY KEY CHECK (code BETWEEN 1 AND 127),
      name_zh           TEXT NOT NULL,
      name_en           TEXT NOT NULL,
      form_selectable   INTEGER NOT NULL DEFAULT 1,
      public_visible    INTEGER NOT NULL DEFAULT 0,
      admin_list_hidden INTEGER NOT NULL DEFAULT 0,
      is_system         INTEGER NOT NULL DEFAULT 0,
      sort              INTEGER NOT NULL DEFAULT 0,
      color_fg          TEXT,
      color_bg          TEXT,
      created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  if (options.seed !== false) {
    database.exec(
      "INSERT INTO ext_book_status " +
        "(code, name_zh, name_en, form_selectable, public_visible, " +
        "admin_list_hidden, is_system, sort) VALUES\n" + SYSTEM_SEED,
    );
  }
  if (options.channels) {
    database.exec(`
      CREATE TABLE channels (
        id VARCHAR(11) PRIMARY KEY,
        status TINYINT,
        is_primary BOOLEAN UNIQUE,
        data TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO channels (id, status, is_primary, data) VALUES
        ('book0000001', 1, 1, '{}'),
        ('book0000002', 1, NULL, '{}'),
        ('book0000003', 2, NULL, '{}'),
        ('book0000004', NULL, NULL, '{}');
    `);
  }
  return new SqliteBookStatusDb(database);
}

describe("book status dictionary reads", () => {
  it("lists the system rows in sort order", async () => {
    const rows = await listBookStatusRows(database());
    expect(rows.map((row) => row.code)).toEqual([1, 2, 3]);
    expect(rows[0]).toEqual({
      code: 1,
      nameZh: "显示",
      nameEn: "Visible",
      formSelectable: true,
      publicVisible: true,
      adminListHidden: false,
      isSystem: true,
      sort: 100,
      // 夹具种子不带配色 → NULL 读成 null（不上色）
      colorFg: null,
      colorBg: null,
    });
  });

  it("derives the three code sets the rest of the app reads", async () => {
    const db = database();
    expect(await listPublicVisibleStatusCodes(db)).toEqual([1]);
    expect(await listAdminListHiddenCodes(db)).toEqual([3]);
    expect(await listFormSelectableStatusCodes(db)).toEqual([1, 2]);
  });

  it("falls back to the system defaults for the form codes when the table is empty", async () => {
    // 与另两个读取同口径：空表时新建书籍仍有 显示/隐藏 可切，不会一律 400。
    const db = database({seed: false});
    expect(await listFormSelectableStatusCodes(db)).toEqual([1, 2]);
  });

  it("falls back to the system defaults when the table is empty", async () => {
    // 迁移未应用或被清空时不能把整站变空：公共可见面退回 1、后台列表排除 3。
    const db = database({seed: false});
    expect(await listPublicVisibleStatusCodes(db)).toEqual([1]);
    expect(await listAdminListHiddenCodes(db)).toEqual([3]);
  });

  it("counts the books on each status, skipping NULL", async () => {
    const counts = await countChannelsByStatus(database({channels: true}));
    expect(counts.get(1)).toBe(2);
    expect(counts.get(2)).toBe(1);
    expect(counts.has(0)).toBe(false);
  });

  it("assigns the smallest free custom code from 10 up", async () => {
    const db = database();
    expect(nextBookStatusCode(await listBookStatusRows(db))).toBe(10);
    await createBookStatus(db, {nameZh: "修订中", nameEn: "Revising"});
    expect(nextBookStatusCode(await listBookStatusRows(db))).toBe(11);
  });

  it("puts a new status after the system rows, not in front of them", async () => {
    // 默认 sort = 现有最大值 + 100：新状态若排到系统行前面，会抢占书籍表单的
    // 首选项与恢复目标（第一轮复审抓到的真 bug）。
    const db = database();
    const created = await createBookStatus(db, {nameZh: "修订中", nameEn: "Revising"});
    expect(created?.sort).toBe(400);
    const second = await createBookStatus(db, {nameZh: "二审中", nameEn: "Reviewing"});
    expect(second?.sort).toBe(500);
    expect((await listBookStatusRows(db)).map((row) => row.code))
      .toEqual([1, 2, 3, 10, 11]);
    // 表单首选项与恢复目标仍是系统行「显示」。
    expect((await listFormSelectableStatusCodes(db))[0]).toBe(1);
  });
});

describe("book status dictionary writes", () => {
  it("creates a hidden-by-default custom status", async () => {
    const db = database();
    const created = await createBookStatus(db, {
      nameZh: "修订中",
      nameEn: "Revising",
      formSelectable: true,
      publicVisible: false,
      sort: 400,
    });
    expect(created).toMatchObject({
      code: 10,
      nameZh: "修订中",
      nameEn: "Revising",
      formSelectable: true,
      // 新状态默认不进前台：要上架由运营显式打开。
      publicVisible: false,
      isSystem: false,
      sort: 400,
    });
    expect(await listPublicVisibleStatusCodes(db)).toEqual([1]);
  });

  it("updates names and flags but never the code", async () => {
    const db = database();
    const updated = await updateBookStatus(db, 2, {
      nameZh: "已下架",
      publicVisible: true,
    });
    expect(updated).toMatchObject({
      code: 2,
      nameZh: "已下架",
      publicVisible: true,
      formSelectable: true,
    });
    expect(await updateBookStatus(db, 99, {nameZh: "x"})).toBeNull();
  });

  it("refuses to delete a system row", async () => {
    const db = database();
    expect(await deleteBookStatus(db, 1)).toBe(false);
    expect(await deleteBookStatus(db, 3)).toBe(false);
    expect((await listBookStatusRows(db)).map((row) => row.code))
      .toEqual([1, 2, 3]);
  });

  it("refuses to delete a status books still carry, then allows it once empty", async () => {
    const db = database({channels: true});
    await createBookStatus(db, {nameZh: "修订中", nameEn: "Revising"});
    // book0000003 sits on code 2 — that row is in use.
    expect(await deleteBookStatus(db, 2)).toBe(false);
    expect(await deleteBookStatus(db, 10)).toBe(true);
    expect((await listBookStatusRows(db)).map((row) => row.code))
      .toEqual([1, 2, 3]);
  });
});

describe("book status colours (migration 0143)", () => {
  it("stores the picked colours on create", async () => {
    const db = database();
    const created = await createBookStatus(db, {
      nameZh: "会员",
      nameEn: "Members",
      colorFg: "#b45309",
      colorBg: "#fef3c7",
    });
    expect(created).toMatchObject({code: 10, colorFg: "#b45309", colorBg: "#fef3c7"});
  });

  it("updates one colour and clears the other with null", async () => {
    const db = database();
    await createBookStatus(db, {
      nameZh: "会员",
      nameEn: "Members",
      colorFg: "#b45309",
      colorBg: "#fef3c7",
    });
    const updated = await updateBookStatus(db, 10, {
      colorFg: "#7c2d12",
      colorBg: null,
    });
    expect(updated).toMatchObject({colorFg: "#7c2d12", colorBg: null});
    // 清空后该行回到「不上色」：books 页徽章走默认文字样式。
    const rows = await listBookStatusRows(db);
    expect(rows.find((row) => row.code === 10)?.colorBg).toBeNull();
  });

  it("accepts only the hex shapes the colour input produces", () => {
    for (const value of ["#abc", "#a1b2c3", "#A1B2C3"]) {
      expect(BOOK_STATUS_COLOR_PATTERN.test(value), value).toBe(true);
    }
    // rgb()/rgba() 刻意不放行：取色器存不了 alpha，收进来只会在下次编辑时
    // 被静默拍平；越界通道（999）与命名色同理拒绝。
    for (const value of [
      "rgb(1,2,3)", "rgba(1,2,3,0.5)", "rgb(999,0,0)", "red", "#12345", "",
    ]) {
      expect(BOOK_STATUS_COLOR_PATTERN.test(value), value).toBe(false);
    }
  });
});

describe("delete state designation", () => {
  it("moves the single delete-state flag when another row claims it", async () => {
    const db = database({channels: true});
    const created = await createBookStatus(db, {nameZh: "下架", nameEn: "Pulled"});
    // 旧持有行（code 3）上没有书，可以转移。
    const moved = await updateBookStatusHandler(db, created!.code, {
      adminListHidden: true,
    });
    expect(moved.adminListHidden).toBe(true);
    const rows = await listBookStatusRows(db);
    expect(rows.filter((row) => row.adminListHidden).map((row) => row.code))
      .toEqual([created!.code]);
    // 软删除此后写新编码。
    expect(await listAdminListHiddenCodes(db)).toEqual([created!.code]);
  });

  it("refuses to move the flag off a code that still carries books", async () => {
    const db = database({channels: true});
    // code 2 上有一本书（book0000003）。
    await expect(updateBookStatusHandler(db, 2, {adminListHidden: true}))
      .rejects.toMatchObject({i18nKey: "errors.bookStatuses.deleteStateInUse"});
    expect(await listAdminListHiddenCodes(db)).toEqual([3]);
  });

  it("refuses to clear the flag outright", async () => {
    const db = database();
    // 取消后软删除无处可写、已删除的书会从两个列表同时消失。
    await expect(updateBookStatusHandler(db, 3, {adminListHidden: false}))
      .rejects.toMatchObject({i18nKey: "errors.bookStatuses.deleteStateRequired"});
  });
});

describe("book status handler guards", () => {
  it("refuses flag changes on a system row but allows name and colour edits", async () => {
    const db = database();
    // 系统行的「前台可见」被拨开会让软删除的书从书架冒出来——服务端拒绝。
    await expect(updateBookStatusHandler(db, 3, {publicVisible: true}))
      .rejects.toMatchObject({i18nKey: "errors.bookStatuses.systemLocked"});
    await expect(updateBookStatusHandler(db, 1, {formSelectable: false}))
      .rejects.toMatchObject({i18nKey: "errors.bookStatuses.systemLocked"});
    // 名称与配色是装扮字段，系统行可改。
    const renamed = await updateBookStatusHandler(db, 2, {
      nameZh: "已下架",
      colorFg: "#111111",
    });
    expect(renamed).toMatchObject({nameZh: "已下架", colorFg: "#111111"});
  });

  it("lets a system-row edit through when the locked flags keep their value", async () => {
    // 编辑框对任何行都带着 formSelectable/publicVisible；按值比较而非按键存在，
    // 否则改一个系统行的名字都会 400（第一轮修复引入、第二轮抓回来的回归）。
    const db = database();
    const edited = await updateBookStatusHandler(db, 2, {
      nameZh: "已下架",
      formSelectable: true,
      publicVisible: false,
    });
    expect(edited).toMatchObject({nameZh: "已下架", formSelectable: true});
  });

  it("reports missing and exhausted codes through AppError", async () => {
    // 带 channels 表：删除自建状态前要数「还有没有书用它」。
    const db = database({channels: true});
    await expect(updateBookStatusHandler(db, 99, {nameZh: "x"}))
      .rejects.toBeInstanceOf(AppError);
    await expect(deleteBookStatusHandler(db, 1))
      .rejects.toMatchObject({i18nKey: "errors.bookStatuses.notDeletable"});
    // 建一个就把 10 占掉；再建仍可（11），删掉自建行后 10 复用。
    await createBookStatusHandler(db, {nameZh: "甲", nameEn: "A"});
    await createBookStatusHandler(db, {nameZh: "乙", nameEn: "B"});
    expect((await listBookStatusRows(db)).map((row) => row.code))
      .toEqual([1, 2, 3, 10, 11]);
    expect(await deleteBookStatusHandler(db, 10)).toEqual({deleted: true});
  });
});
