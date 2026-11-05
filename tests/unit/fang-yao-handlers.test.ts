import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {SqliteStatement} from "./support/sqlite-statement";
import {
  FANG_YAO_ERRORS,
  createFangYaoBodyHandler,
  createFangYaoHandler,
  deleteFangYaoBodyHandler,
  deleteFangYaoHandler,
  listFangYaoBoardHandler,
  listFangYaoBodiesHandler,
  purgeFangYaoBodyHandler,
  purgeFangYaoHandler,
  updateFangYaoBodyHandler,
  updateFangYaoHandler,
} from "@/server/fang-yao/handlers";
import type {
  FangYaoDb,
  FangYaoDbPreparedStatement,
} from "@/server/fang-yao/types";
// 建表/编辑 schema 真源在 shared（handlers 也从这里 import），测试直取真源。
import {
  fangYaoBodyCreateSchema,
  fangYaoCreateSchema,
} from "@/shared/FangYao";
import {AppError} from "@/shared/errors";
import {ADMIN_MENU_CODES, PERMISSION_CODES} from "@/shared/Constants";



class SqliteFangYaoDb implements FangYaoDb {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): FangYaoDbPreparedStatement {
    return new SqliteStatement(this.database, query);
  }
}

/** 镜像迁移 0184 的两表 DDL（含 UNIQUE 索引），供 handler 端口测试。 */
function emptyDatabase(): SqliteFangYaoDb {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE fang_yao (
      id                     VARCHAR(11) PRIMARY KEY,
      fang_no                INTEGER NOT NULL,
      fang_name              VARCHAR(255) NOT NULL,
      source_book_legacy_id  VARCHAR(64),
      source_book_name       VARCHAR(255),
      source_fang_legacy_id  VARCHAR(64),
      yao_list               TEXT,
      fang_text              TEXT NOT NULL,
      fang_drink_num         VARCHAR(64),
      is_enable              INTEGER NOT NULL DEFAULT 1,
      signature_id           VARCHAR(64),
      signature              VARCHAR(64),
      created_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at             TIMESTAMP,
      ext1 VARCHAR(255), ext2 VARCHAR(255), ext3 VARCHAR(255), ext4 VARCHAR(255), ext5 VARCHAR(255),
      ext6 VARCHAR(255), ext7 VARCHAR(255), ext8 VARCHAR(255), ext9 VARCHAR(255), ext10 VARCHAR(255)
    );
    CREATE UNIQUE INDEX fang_yao_book_no ON fang_yao (source_book_legacy_id, fang_no);
    CREATE UNIQUE INDEX fang_yao_source_fang ON fang_yao (source_fang_legacy_id);

    CREATE TABLE fang_yao_body (
      id             VARCHAR(11) PRIMARY KEY,
      fang_yao_id    VARCHAR(11) NOT NULL,
      position       INTEGER NOT NULL,
      show_name      VARCHAR(64) NOT NULL,
      amount         VARCHAR(255),
      extra_process  VARCHAR(64),
      weight         VARCHAR(32),
      yao_legacy_id  VARCHAR(64),
      is_enable      INTEGER NOT NULL DEFAULT 1,
      signature_id   VARCHAR(64),
      signature      VARCHAR(64),
      created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at     TIMESTAMP,
      ext1 VARCHAR(255), ext2 VARCHAR(255), ext3 VARCHAR(255), ext4 VARCHAR(255), ext5 VARCHAR(255),
      ext6 VARCHAR(255), ext7 VARCHAR(255), ext8 VARCHAR(255), ext9 VARCHAR(255), ext10 VARCHAR(255)
    );
    CREATE INDEX fang_yao_body_fang ON fang_yao_body (fang_yao_id);
    CREATE UNIQUE INDEX fang_yao_body_position ON fang_yao_body (fang_yao_id, position);
  `);
  return new SqliteFangYaoDb(database);
}

describe("fangYao shared schema", () => {
  it("rejects a blank fang_name but keeps surrounding spaces", () => {
    expect(fangYaoCreateSchema.safeParse({fangName: "", fangText: "$u{桂枝}"}).success).toBe(false);
    expect(fangYaoCreateSchema.safeParse({fangName: "   ", fangText: "$u{桂枝}"}).success).toBe(false);

    const parsed = fangYaoCreateSchema.safeParse({
      fangName: "  桂枝汤  ",
      fangText: "$u{桂枝}$w{三两}",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.fangName).toBe("  桂枝汤  ");
  });

  it("requires fang_text and does not trim it", () => {
    expect(fangYaoCreateSchema.safeParse({fangName: "桂枝汤"}).success).toBe(false);

    const text = "  $u{桂枝}$w{三两}\n  $u{芍药}$w{三两}  ";
    const parsed = fangYaoCreateSchema.safeParse({fangName: "桂枝汤", fangText: text});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.fangText).toBe(text);
  });

  it("accepts an amount with an embedded $x{} marker verbatim", () => {
    const amount = "  $x{十八铢}  ";
    // showName 必填非空（ADR-0065 NOT NULL）；amount 是唯一关心的字段，原样保留
    const parsed = fangYaoBodyCreateSchema.safeParse({showName: "猪苓", amount});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.amount).toBe(amount);
  });
});

describe("fangYao permission wiring", () => {
  // 三镜像（Constants / rbac seed / 迁移 0184）里这一层最容易漂：
  // 权限码一旦与既有的 content:fang:*（legacy fangs 页）/ content:chapter:*
  // / content:book:* 撞车，后台会互相顶掉。
  it("uses the dedicated content:fang-yao codes and the fang_yao menu", () => {
    expect(PERMISSION_CODES.CONTENT_FANG_YAO_READ).toBe("content:fang-yao:read");
    expect(PERMISSION_CODES.CONTENT_FANG_YAO_MANAGE).toBe("content:fang-yao:manage");
    expect(ADMIN_MENU_CODES.FANG_YAO).toBe("fang_yao");
    // 菜单码去掉 page_ 前缀即节点 id，侧栏靠它推导
    expect(`page_${ADMIN_MENU_CODES.FANG_YAO}`).toBe("page_fang_yao");
  });
});

describe("fangYao handlers", () => {
  it("creates a formula with a generated 11-char id and returns it in the board", async () => {
    const db = emptyDatabase();
    const created = await createFangYaoHandler(db, {
      fangName: "桂枝汤",
      sourceBookLegacyId: "10001",
      sourceBookName: "伤寒金匮・(宋版)",
      fangText: "$u{桂枝}$w{三两}",
    });
    expect(created.id).toHaveLength(11);
    expect(created.fangNo).toBe(1);
    expect(created.fangName).toBe("桂枝汤");

    const board = await listFangYaoBoardHandler(db);
    expect(board.formulas).toHaveLength(1);
    expect(board.groups).toEqual([
      {key: "10001", name: "伤寒金匮・(宋版)", count: 1},
    ]);
  });

  it("aggregates board groups by source_book_legacy_id counting only non-deleted formulas", async () => {
    const db = emptyDatabase();
    const a = await createFangYaoHandler(db, {
      fangName: "桂枝汤",
      sourceBookLegacyId: "10001",
      sourceBookName: "伤寒金匮・(宋版)",
      fangText: "$u{桂枝}",
    });
    await createFangYaoHandler(db, {
      fangName: "麻黄汤",
      sourceBookLegacyId: "10001",
      sourceBookName: "伤寒金匮・(宋版)",
      fangText: "$u{麻黄}",
    });
    await createFangYaoHandler(db, {
      fangName: "小柴胡汤",
      sourceBookLegacyId: "1001000",
      sourceBookName: "伤寒杂病论・(桂林古本)",
      fangText: "$u{柴胡}",
    });
    // 软删一方的计数应从组内剔除（isDeleted 不入组）
    await deleteFangYaoHandler(db, a.id);

    const board = await listFangYaoBoardHandler(db);
    // 同 count=1 时按 key 升序：10001 < 1001000（localeCompare）
    expect(board.groups).toEqual([
      {key: "10001", name: "伤寒金匮・(宋版)", count: 1},
      {key: "1001000", name: "伤寒杂病论・(桂林古本)", count: 1},
    ]);
  });

  it("falls back the group name to the legacy id when source_book_name is empty", async () => {
    const db = emptyDatabase();
    await createFangYaoHandler(db, {
      fangName: "附子汤",
      sourceBookLegacyId: "9050000",
      sourceBookName: null,
      fangText: "$u{附子}",
    });
    const board = await listFangYaoBoardHandler(db);
    expect(board.groups).toEqual([{key: "9050000", name: "9050000", count: 1}]);
  });

  it("rejects an invalid create payload with AppError 400", async () => {
    const db = emptyDatabase();
    await expect(createFangYaoHandler(db, {fangName: "  "}))
      .rejects.toBeInstanceOf(AppError);
    await expect(createFangYaoHandler(db, {fangName: ""}))
      .rejects.toMatchObject({
        status: 400,
        i18nKey: FANG_YAO_ERRORS.invalidInput,
      });
    await expect(createFangYaoHandler(db, {fangName: "桂枝汤", fangText: ""}))
      .rejects.toMatchObject({
        status: 400,
        i18nKey: FANG_YAO_ERRORS.invalidInput,
      });
  });

  it("rejects an empty update patch and reports 404 for an unknown id", async () => {
    const db = emptyDatabase();
    const created = await createFangYaoHandler(db, {fangName: "桂枝汤", fangText: "$u{桂枝}"});

    await expect(updateFangYaoHandler(db, created.id, {}))
      .rejects.toMatchObject({
        status: 400,
        i18nKey: FANG_YAO_ERRORS.invalidInput,
      });

    await expect(updateFangYaoHandler(db, "nope0000000", {fangName: "改"}))
      .rejects.toMatchObject({status: 404, i18nKey: FANG_YAO_ERRORS.notFound});
  });

  it("reports 404 for get/update/delete/purge of an unknown id", async () => {
    const db = emptyDatabase();
    await expect(updateFangYaoHandler(db, "nope0000000", {fangName: "x"}))
      .rejects.toMatchObject({status: 404, i18nKey: FANG_YAO_ERRORS.notFound});
    await expect(purgeFangYaoHandler(db, "nope0000000"))
      .rejects.toMatchObject({status: 404, i18nKey: FANG_YAO_ERRORS.notFound});
    await expect(deleteFangYaoHandler(db, "nope0000000"))
      .rejects.toMatchObject({status: 404, i18nKey: FANG_YAO_ERRORS.notFound});
  });

  it("soft deletes, then purges; purge needs a prior soft delete", async () => {
    const db = emptyDatabase();
    const created = await createFangYaoHandler(db, {fangName: "麻黄汤", fangText: "$u{麻黄}"});

    await expect(purgeFangYaoHandler(db, created.id))
      .rejects.toMatchObject({
        status: 409,
        i18nKey: FANG_YAO_ERRORS.purgeNeedsDelete,
      });

    await expect(deleteFangYaoHandler(db, created.id)).resolves.toEqual({deleted: true});
    await expect(purgeFangYaoHandler(db, created.id)).resolves.toEqual({purged: true});
    await expect(deleteFangYaoHandler(db, created.id))
      .rejects.toMatchObject({status: 404, i18nKey: FANG_YAO_ERRORS.notFound});
  });

  it("refuses to purge a formula that still has bodies", async () => {
    const db = emptyDatabase();
    const fang = await createFangYaoHandler(db, {fangName: "小柴胡汤", fangText: "$u{柴胡}"});
    await createFangYaoBodyHandler(db, fang.id, {showName: "柴胡", amount: "半斤"});

    await expect(deleteFangYaoHandler(db, fang.id)).resolves.toEqual({deleted: true});
    await expect(purgeFangYaoHandler(db, fang.id))
      .rejects.toMatchObject({
        status: 409,
        i18nKey: FANG_YAO_ERRORS.purgeHasBodies,
      });
  });

  it("creates bodies under a formula and lists them back", async () => {
    const db = emptyDatabase();
    const fang = await createFangYaoHandler(db, {fangName: "桂枝汤", fangText: "$u{桂枝}"});

    const first = await createFangYaoBodyHandler(db, fang.id, {
      showName: "桂枝",
      amount: "三两",
    });
    expect(first.id).toHaveLength(11);
    expect(first.position).toBe(1);
    expect(first.fangYaoId).toBe(fang.id);

    const second = await createFangYaoBodyHandler(db, fang.id, {
      showName: "芍药",
      amount: "  三两  ",
    });
    // 文本原样入库，不被 trim
    expect(second.amount).toBe("  三两  ");

    const listed = await listFangYaoBodiesHandler(db, fang.id);
    expect(listed.bodies.map((body) => body.position)).toEqual([1, 2]);
    expect(listed.bodies[1]?.amount).toBe("  三两  ");
  });

  it("rejects a body create under a missing formula id", async () => {
    const db = emptyDatabase();
    await expect(createFangYaoBodyHandler(db, "", {showName: "桂枝"}))
      .rejects.toMatchObject({
        status: 400,
        i18nKey: FANG_YAO_ERRORS.invalidInput,
      });
  });

  it("updates and deletes a body; unknown body ids report 404", async () => {
    const db = emptyDatabase();
    const fang = await createFangYaoHandler(db, {fangName: "五苓散", fangText: "$u{猪苓}"});
    const body = await createFangYaoBodyHandler(db, fang.id, {showName: "猪苓", amount: "十八铢"});

    const updated = await updateFangYaoBodyHandler(db, body.id, {
      amount: "  一两六铢  ",
    });
    expect(updated.amount).toBe("  一两六铢  ");

    await expect(updateFangYaoBodyHandler(db, "nope0000000", {amount: "改"}))
      .rejects.toMatchObject({status: 404, i18nKey: FANG_YAO_ERRORS.notFound});

    await expect(purgeFangYaoBodyHandler(db, body.id))
      .rejects.toMatchObject({
        status: 409,
        i18nKey: FANG_YAO_ERRORS.purgeNeedsDelete,
      });

    await expect(deleteFangYaoBodyHandler(db, body.id)).resolves.toEqual({deleted: true});
    await expect(purgeFangYaoBodyHandler(db, body.id)).resolves.toEqual({purged: true});
  });
});
