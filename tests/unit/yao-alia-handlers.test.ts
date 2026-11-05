import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {SqliteStatement} from "./support/sqlite-statement";
import {
  createYaoAliaHandler,
  deleteYaoAliaHandler,
  listYaoAliaBoardHandler,
  purgeYaoAliaHandler,
  updateYaoAliaHandler,
  YAO_ALIA_ERRORS,
} from "@/server/yao-alia/handlers";
import type {
  YaoAliaDb,
  YaoAliaDbPreparedStatement,
} from "@/server/yao-alia/types";
import {AppError} from "@/shared/errors";



class SqliteYaoAliaDb implements YaoAliaDb {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): YaoAliaDbPreparedStatement {
    return new SqliteStatement(this.database, query);
  }
}

/** 镜像迁移 0183 `yao_alia` 的 DDL。别名模块无分组表、无 settings、无来源书，
 *  handler 只吃单个 `YaoAliaDb`（对比 ming-ci 的 `groupsDb` + `sourceBooks`）。 */
function emptyDatabase(): SqliteYaoAliaDb {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE yao_alia (
      id                VARCHAR(11) PRIMARY KEY,
      yao_alia_no       INTEGER NOT NULL,
      yao_alia_bie_ming VARCHAR(255) NOT NULL,
      yao_alia_name     VARCHAR(255) NOT NULL,
      is_enable         INTEGER NOT NULL DEFAULT 1,
      signature_id      VARCHAR(64),
      signature         VARCHAR(64),
      created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at        TIMESTAMP,
      ext1 VARCHAR(255), ext2 VARCHAR(255), ext3 VARCHAR(255), ext4 VARCHAR(255), ext5 VARCHAR(255),
      ext6 VARCHAR(255), ext7 VARCHAR(255), ext8 VARCHAR(255), ext9 VARCHAR(255), ext10 VARCHAR(255)
    );
    CREATE UNIQUE INDEX yao_alia_no_unique ON yao_alia (yao_alia_no);
    CREATE UNIQUE INDEX yao_alia_bie_ming_unique ON yao_alia (yao_alia_bie_ming);
    CREATE INDEX yao_alia_name ON yao_alia (yao_alia_name);
  `);
  return new SqliteYaoAliaDb(database);
}

describe("yao_alia handlers", () => {
  it("create handler rejects invalid input with AppError 400", async () => {
    const db = emptyDatabase();
    await expect(
      createYaoAliaHandler(db, {bieMing: "", yaoName: "白术"}),
    ).rejects.toMatchObject({
      i18nKey: YAO_ALIA_ERRORS.invalidInput,
      status: 400,
    });
    await expect(createYaoAliaHandler(db, null)).rejects.toBeInstanceOf(AppError);
  });

  it("create handler generates an 11-char id and the board reads it back", async () => {
    const db = emptyDatabase();
    const created = await createYaoAliaHandler(db, {
      bieMing: "术",
      yaoName: "白术",
    });
    expect(created.id).toHaveLength(11);
    expect(created.yaoAliaNo).toBe(1);
    expect(created.isEnable).toBe(true);
    const board = await listYaoAliaBoardHandler(db);
    expect(board.entries).toHaveLength(1);
    expect(board.entries[0]?.id).toBe(created.id);
  });

  it("create handler trims the submitted text before persisting", async () => {
    const db = emptyDatabase();
    const created = await createYaoAliaHandler(db, {
      bieMing: "  术  ",
      yaoName: "  白术  ",
    });
    // trim 在 Zod 层，store 不做归一；两条路径合起来才不会把首尾空白落库。
    expect(created.bieMing).toBe("术");
    expect(created.yaoName).toBe("白术");
  });

  it("create handler surfaces a duplicate alias as a UNIQUE violation", async () => {
    const db = emptyDatabase();
    await createYaoAliaHandler(db, {bieMing: "术", yaoName: "白术"});
    // 唯一冲突不转成 AppError：交给 ajax 层 serviceError 就地抛（fail-fast、不静默合并）。
    await expect(
      createYaoAliaHandler(db, {bieMing: "术", yaoName: "苍术"}),
    ).rejects.toThrow(/UNIQUE/u);
  });

  it("update handler 404s on a missing id and 400s on an empty patch", async () => {
    const db = emptyDatabase();
    await expect(
      updateYaoAliaHandler(db, "missing1", {yaoName: "黄芪"}),
    ).rejects.toMatchObject({status: 404, i18nKey: YAO_ALIA_ERRORS.notFound});
    const created = await createYaoAliaHandler(db, {
      bieMing: "术",
      yaoName: "白术",
    });
    // 空 patch（所有字段 undefined）→ 400
    await expect(
      updateYaoAliaHandler(db, created.id, {}),
    ).rejects.toMatchObject({status: 400, i18nKey: YAO_ALIA_ERRORS.invalidInput});
  });

  it("update handler persists a partial patch and preserves untouched fields", async () => {
    const db = emptyDatabase();
    const created = await createYaoAliaHandler(db, {
      bieMing: "桂心",
      yaoName: "桂枝",
    });
    const updated = await updateYaoAliaHandler(db, created.id, {yaoName: "肉桂"});
    expect(updated.yaoName).toBe("肉桂");
    expect(updated.bieMing).toBe("桂心"); // 未 touch 保留
    expect(updated.yaoAliaNo).toBe(created.yaoAliaNo);
  });

  it("update handler rejects a null for a NOT NULL column", async () => {
    const db = emptyDatabase();
    const created = await createYaoAliaHandler(db, {
      bieMing: "术",
      yaoName: "白术",
    });
    await expect(
      updateYaoAliaHandler(db, created.id, {yaoName: null}),
    ).rejects.toMatchObject({status: 400, i18nKey: YAO_ALIA_ERRORS.invalidInput});
  });

  it("delete handler 404s on a missing id and soft-deletes once", async () => {
    const db = emptyDatabase();
    await expect(
      deleteYaoAliaHandler(db, "missing1"),
    ).rejects.toMatchObject({status: 404, i18nKey: YAO_ALIA_ERRORS.notFound});

    const created = await createYaoAliaHandler(db, {
      bieMing: "枣膏",
      yaoName: "大枣",
    });
    await expect(deleteYaoAliaHandler(db, created.id)).resolves.toEqual({
      deleted: true,
    });
    // 第二次软删：已软删的行不再算「删除成功」
    await expect(
      deleteYaoAliaHandler(db, created.id),
    ).rejects.toMatchObject({status: 404});
    const board = await listYaoAliaBoardHandler(db);
    expect(board.entries[0]?.isDeleted).toBe(true);
  });

  it("purge handler 409s on an un-deleted row and succeeds after soft delete", async () => {
    const db = emptyDatabase();
    const created = await createYaoAliaHandler(db, {
      bieMing: "法醋",
      yaoName: "苦酒",
    });
    await expect(
      purgeYaoAliaHandler(db, created.id),
    ).rejects.toMatchObject({
      status: 409,
      i18nKey: YAO_ALIA_ERRORS.purgeNeedsDelete,
    });
    await deleteYaoAliaHandler(db, created.id);
    await expect(purgeYaoAliaHandler(db, created.id)).resolves.toEqual({
      purged: true,
    });
    // 物删之后 id 彻底不存在
    await expect(
      purgeYaoAliaHandler(db, created.id),
    ).rejects.toMatchObject({status: 404, i18nKey: YAO_ALIA_ERRORS.notFound});
  });

  it("board returns live and soft-deleted rows together (UI splits them)", async () => {
    const db = emptyDatabase();
    const live = await createYaoAliaHandler(db, {bieMing: "术", yaoName: "白术"});
    const removed = await createYaoAliaHandler(db, {bieMing: "朮", yaoName: "白术"});
    await deleteYaoAliaHandler(db, removed.id);
    const board = await listYaoAliaBoardHandler(db);
    // 一次性返回整表：左栏按 isDeleted 分「树」与「已软删折叠区」。
    expect(board.entries).toHaveLength(2);
    expect(board.entries.filter((entry) => !entry.isDeleted).map((entry) => entry.id))
      .toEqual([live.id]);
    expect(board.entries.filter((entry) => entry.isDeleted).map((entry) => entry.id))
      .toEqual([removed.id]);
  });
});
