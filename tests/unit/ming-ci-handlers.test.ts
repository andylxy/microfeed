import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {SqliteStatement} from "./support/sqlite-statement";
import {
  createMingCiHandler,
  deleteMingCiHandler,
  listMingCiBoardHandler,
  listMingCiGroupsHandler,
  MING_CI_ERRORS,
  purgeMingCiHandler,
  reassignMingCiGroupHandler,
  saveMingCiGroupsHandler,
  updateMingCiHandler,
} from "@/server/ming-ci/handlers";
import type {
  MingCiDb,
  MingCiDbPreparedStatement,
} from "@/server/ming-ci/types";
// 建表/编辑 schema 真源在 shared（handlers 也从这里 import），测试直取真源。
import {
  mingCiCreateSchema,
  mingCiUpdateSchema,
} from "@/shared/MingCi";
import {AppError} from "@/shared/errors";



class SqliteMingCiDb implements MingCiDb {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): MingCiDbPreparedStatement {
    return new SqliteStatement(this.database, query);
  }
}

/** handler 的分组/来源书 IO 吃 `D1Database`（settings / book_info 通道），测试投成同一形状。 */
function asD1(db: SqliteMingCiDb): D1Database {
  return db as unknown as D1Database;
}

/** 镜像迁移 0177 `ming_ci` + 0178 `settings` + 0175 `book_info`（来源书下拉）的 DDL，
 *  供 handler 级往返测试。`settings` 表必带：create/update handler 会经
 *  `loadMingCiGroups` 走 settings 通道严格校验 `ming_ci_type`，缺表会抛
 *  `no such table` 而非业务 400。 */
function emptyDatabase(): SqliteMingCiDb {
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
      book_no         TEXT NOT NULL DEFAULT '',
      deleted_at      TIMESTAMP
    );
    CREATE TABLE ming_ci (
      id              VARCHAR(11) PRIMARY KEY,
      ming_ci_no      INTEGER NOT NULL,
      ming_ci_name    VARCHAR(255) NOT NULL,
      ming_ci_bei_ming VARCHAR(255),
      ming_ci_text    TEXT NOT NULL,
      ming_ci_list    TEXT NOT NULL DEFAULT '[]',
      source_book_id  VARCHAR(11),
      ming_ci_type    VARCHAR(255) NOT NULL,
      show_image      VARCHAR(255),
      remark          TEXT,
      is_enable       INTEGER NOT NULL DEFAULT 1,
      signature_id    VARCHAR(64),
      signature       VARCHAR(64),
      created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at      TIMESTAMP,
      ext1 VARCHAR(255), ext2 VARCHAR(255), ext3 VARCHAR(255), ext4 VARCHAR(255), ext5 VARCHAR(255),
      ext6 VARCHAR(255), ext7 VARCHAR(255), ext8 VARCHAR(255), ext9 VARCHAR(255), ext10 VARCHAR(255)
    );
    CREATE UNIQUE INDEX ming_ci_no_unique ON ming_ci (ming_ci_no);
  `);
  return new SqliteMingCiDb(database);
}

/** 播种迁移 0178 的分组快照（4 键）。 */
function seedGroups(db: SqliteMingCiDb): void {
  const json = JSON.stringify({groups: [
    {key: "yili", label: "医理", sort: 0},
    {key: "yaoli", label: "药理", sort: 1},
    {key: "zhouyi", label: "易理", sort: 2},
    {key: "tongyong", label: "通用", sort: 3},
  ]});
  db.prepare(
    "INSERT OR IGNORE INTO settings (category, data) VALUES ('mingci_groups', ?)",
  ).bind(json).run();
}

/** 播种迁移 0175 的来源书。 */
function seedSourceBooks(db: SqliteMingCiDb): void {
  db.prepare(
    "INSERT INTO book_info (id, book_name, book_no) VALUES (?, ?, ?)",
  ).bind("XNK0VFX39Xv", "内经", "1").run();
  db.prepare(
    "INSERT INTO book_info (id, book_name, book_no) VALUES (?, ?, ?)",
  ).bind("OsOP62cyp3j", "本草", "2").run();
}

describe("ming_ci Zod schemas", () => {
  it("rejects a create payload with an empty name", () => {
    expect(
      mingCiCreateSchema.safeParse({
        mingCiName: "",
        mingCiType: "yili",
        mingCiText: "内容",
      }).success,
    ).toBe(false);
  });

  it("rejects an empty content (NOT NULL column)", () => {
    expect(
      mingCiCreateSchema.safeParse({
        mingCiName: "名词",
        mingCiType: "yili",
        mingCiText: "",
      }).success,
    ).toBe(false);
  });

  it("rejects an empty type (NOT NULL, must hit a group key)", () => {
    expect(
      mingCiCreateSchema.safeParse({
        mingCiName: "名词",
        mingCiType: "",
        mingCiText: "内容",
      }).success,
    ).toBe(false);
  });

  it("accepts a full valid payload and trims text", () => {
    const parsed = mingCiCreateSchema.safeParse({
      mingCiName: "  阴阳  ",
      mingCiType: "  yili  ",
      mingCiText: "阴阳者，天地之道也。",
      mingCiBeiMing: "  阴阳学说  ",
      mingCiList: ["阴阳", "对立"],
      sourceBookId: "XNK0VFX39Xv",
      showImage: "   /img/yy.png  ",
      remark: "  备注  ",
      isEnable: false,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.mingCiName).toBe("阴阳");
      expect(parsed.data.mingCiType).toBe("yili");
      expect(parsed.data.mingCiBeiMing).toBe("阴阳学说");
      expect(parsed.data.showImage).toBe("/img/yy.png");
      expect(parsed.data.isEnable).toBe(false);
    }
  });

  it("update schema makes every field optional but keeps non-null fields non-null", () => {
    const parsed = mingCiUpdateSchema.safeParse({mingCiType: "yaoli"});
    expect(parsed.success).toBe(true);
    // 非空列更新时不可写成 null
    expect(
      mingCiUpdateSchema.safeParse({mingCiName: null}).success,
    ).toBe(false);
    expect(
      mingCiUpdateSchema.safeParse({mingCiText: null}).success,
    ).toBe(false);
    expect(
      mingCiUpdateSchema.safeParse({mingCiType: null}).success,
    ).toBe(false);
  });
});

describe("ming_ci handlers", () => {
  it("create handler rejects invalid input with AppError 400", async () => {
    const db = emptyDatabase();
    seedGroups(db);
    await expect(
      createMingCiHandler(db, asD1(db), {mingCiName: ""}),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("create handler rejects a type outside the group list (strict validation, fail-closed)", async () => {
    const db = emptyDatabase();
    seedGroups(db);
    await expect(
      createMingCiHandler(db, asD1(db), {
        mingCiName: "名词",
        mingCiText: "内容",
        mingCiType: "不存在类",
      }),
    ).rejects.toMatchObject({status: 400, i18nKey: MING_CI_ERRORS.invalidType});
  });

  it("create handler rejects every type when the group list is empty (fail-closed)", async () => {
    const db = emptyDatabase();
    // 不 seed groups → 空清单 → 任何类型都拒。
    await expect(
      createMingCiHandler(db, asD1(db), {
        mingCiName: "名词",
        mingCiText: "内容",
        mingCiType: "yili",
      }),
    ).rejects.toMatchObject({status: 400, i18nKey: MING_CI_ERRORS.invalidType});
  });

  it("create handler persists a valid noun and reads it back on the board", async () => {
    const db = emptyDatabase();
    seedGroups(db);
    seedSourceBooks(db);
    const created = await createMingCiHandler(db, asD1(db), {
      mingCiName: "阴阳",
      mingCiText: "阴阳者，天地之道也。",
      mingCiType: "yili",
      sourceBookId: "XNK0VFX39Xv",
      mingCiList: ["阴阳学说"],
    });
    expect(created.id).toHaveLength(11);
    expect(created.mingCiType).toBe("yili");
    const board = await listMingCiBoardHandler(db, asD1(db));
    expect(board.groups).toHaveLength(4);
    expect(board.sourceBooks).toHaveLength(2);
    expect(board.nouns).toHaveLength(1);
    expect(board.nouns[0]?.id).toBe(created.id);
  });

  it("update handler 404s on a missing id and 400s on an empty patch", async () => {
    const db = emptyDatabase();
    seedGroups(db);
    await expect(
      updateMingCiHandler(db, asD1(db), "missing1", {mingCiType: "yili"}),
    ).rejects.toMatchObject({status: 404, i18nKey: MING_CI_ERRORS.notFound});
    // 空 patch（所有字段 undefined）→ 400
    const created = await createMingCiHandler(db, asD1(db), {
      mingCiName: "名词",
      mingCiText: "内容",
      mingCiType: "yili",
    });
    await expect(
      updateMingCiHandler(db, asD1(db), created.id, {}),
    ).rejects.toMatchObject({status: 400, i18nKey: MING_CI_ERRORS.invalidInput});
  });

  it("update handler rejects a type outside the group list", async () => {
    const db = emptyDatabase();
    seedGroups(db);
    const created = await createMingCiHandler(db, asD1(db), {
      mingCiName: "名词",
      mingCiText: "内容",
      mingCiType: "yili",
    });
    await expect(
      updateMingCiHandler(db, asD1(db), created.id, {mingCiType: "不存在类"}),
    ).rejects.toMatchObject({status: 400, i18nKey: MING_CI_ERRORS.invalidType});
  });

  it("delete handler 404s on a missing id", async () => {
    const db = emptyDatabase();
    await expect(
      deleteMingCiHandler(db, "missing1"),
    ).rejects.toMatchObject({status: 404});
  });

  it("purge handler 409s on an un-deleted row and succeeds after soft delete", async () => {
    const db = emptyDatabase();
    seedGroups(db);
    const created = await createMingCiHandler(db, asD1(db), {
      mingCiName: "名词",
      mingCiText: "内容",
      mingCiType: "yili",
    });
    await expect(
      purgeMingCiHandler(db, created.id),
    ).rejects.toMatchObject({status: 409, i18nKey: MING_CI_ERRORS.purgeNeedsDelete});

    await deleteMingCiHandler(db, created.id);
    await expect(purgeMingCiHandler(db, created.id)).resolves.toEqual({
      purged: true,
    });
  });

  it("save groups rejects an empty list (last group fail-closed)", async () => {
    const db = emptyDatabase();
    seedGroups(db);
    await expect(
      saveMingCiGroupsHandler(db, asD1(db), {groups: []}),
    ).rejects.toMatchObject({status: 400, i18nKey: MING_CI_ERRORS.lastGroup});
  });

  it("save groups rejects removing a group that still has live nouns (must reassign first)", async () => {
    const db = emptyDatabase();
    seedGroups(db);
    await createMingCiHandler(db, asD1(db), {
      mingCiName: "阴阳",
      mingCiText: "内容",
      mingCiType: "yili",
    });
    // 新清单只留 3 组（删 yili），但 yili 还有 1 条在册名词 → 409。
    const remaining = [
      {key: "yaoli", label: "药理", sort: 0},
      {key: "zhouyi", label: "易理", sort: 1},
      {key: "tongyong", label: "通用", sort: 2},
    ];
    await expect(
      saveMingCiGroupsHandler(db, asD1(db), {groups: remaining}),
    ).rejects.toMatchObject({status: 409, i18nKey: MING_CI_ERRORS.groupHasNouns});
  });

  it("save groups succeeds when the removed group is empty", async () => {
    const db = emptyDatabase();
    seedGroups(db);
    // yili 空组可删；其余保留。
    const remaining = [
      {key: "yaoli", label: "药理", sort: 0},
      {key: "zhouyi", label: "易理", sort: 1},
      {key: "tongyong", label: "通用", sort: 2},
    ];
    const saved = await saveMingCiGroupsHandler(db, asD1(db), {groups: remaining});
    expect(saved.groups).toHaveLength(3);
    expect((await listMingCiGroupsHandler(asD1(db))).map((g) => g.key))
      .toEqual(["yaoli", "zhouyi", "tongyong"]);
  });

  it("reassign handler rejects a from/to pair not both in the current list", async () => {
    const db = emptyDatabase();
    seedGroups(db);
    await expect(
      reassignMingCiGroupHandler(db, asD1(db), {from: "不存在", to: "yili"}),
    ).rejects.toMatchObject({status: 400, i18nKey: MING_CI_ERRORS.invalidGroup});
  });

  it("reassign handler moves a group's nouns and persists the new type", async () => {
    const db = emptyDatabase();
    seedGroups(db);
    const created = await createMingCiHandler(db, asD1(db), {
      mingCiName: "阴阳",
      mingCiText: "内容",
      mingCiType: "yili",
    });
    await reassignMingCiGroupHandler(db, asD1(db), {from: "yili", to: "yaoli"});
    const board = await listMingCiBoardHandler(db, asD1(db));
    expect(board.nouns[0]?.id).toBe(created.id);
    expect(board.nouns[0]?.mingCiType).toBe("yaoli");
  });
});
