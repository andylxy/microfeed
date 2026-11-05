import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {SqliteStatement} from "./support/sqlite-statement";
import {
  createZhongYaoHandler,
  deleteZhongYaoHandler,
  listZhongYaoBoardHandler,
  purgeZhongYaoHandler,
  updateZhongYaoHandler,
  ZHONG_YAO_ERRORS,
} from "@/server/zhong-yao/handlers";
import type {
  ZhongYaoDb,
  ZhongYaoDbPreparedStatement,
} from "@/server/zhong-yao/types";
// 建表/编辑 schema 真源在 shared（handlers 也从这里 import），测试直取真源。
import {
  zhongYaoCreateSchema,
  zhongYaoUpdateSchema,
} from "@/shared/ZhongYao";
import {AppError} from "@/shared/errors";



class SqliteZhongYaoDb implements ZhongYaoDb {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): ZhongYaoDbPreparedStatement {
    return new SqliteStatement(this.database, query);
  }
}

/** 镜像迁移 0180 `zhong_yao` 的 DDL。本草无分组/来源书/settings 通道，
 *  handler 只吃单个 `ZhongYaoDb`（对比 ming-ci 的 `groupsDb`），无需 seed 其它表。 */
function emptyDatabase(): SqliteZhongYaoDb {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE zhong_yao (
      id               VARCHAR(11) PRIMARY KEY,
      zhong_yao_no     INTEGER NOT NULL,
      zhong_yao_name   VARCHAR(255) NOT NULL,
      zhong_yao_bei_ming VARCHAR(255),
      zhong_yao_text   TEXT NOT NULL,
      zhong_yao_list   TEXT NOT NULL DEFAULT '[]',
      is_enable        INTEGER NOT NULL DEFAULT 1,
      signature_id     VARCHAR(64),
      signature        VARCHAR(64),
      created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at       TIMESTAMP,
      ext1 VARCHAR(255), ext2 VARCHAR(255), ext3 VARCHAR(255), ext4 VARCHAR(255), ext5 VARCHAR(255),
      ext6 VARCHAR(255), ext7 VARCHAR(255), ext8 VARCHAR(255), ext9 VARCHAR(255), ext10 VARCHAR(255)
    );
    CREATE INDEX zhong_yao_name ON zhong_yao (zhong_yao_name);
    CREATE UNIQUE INDEX zhong_yao_no_unique ON zhong_yao (zhong_yao_no);
  `);
  return new SqliteZhongYaoDb(database);
}

describe("zhong_yao Zod schemas", () => {
  it("rejects a create payload with an empty name", () => {
    expect(
      zhongYaoCreateSchema.safeParse({
        zhongYaoName: "",
        zhongYaoText: "内容",
      }).success,
    ).toBe(false);
  });

  it("rejects an empty content (NOT NULL column)", () => {
    expect(
      zhongYaoCreateSchema.safeParse({
        zhongYaoName: "人参",
        zhongYaoText: "",
      }).success,
    ).toBe(false);
  });

  it("accepts a full valid payload, trims name/alias but keeps content verbatim", () => {
    const parsed = zhongYaoCreateSchema.safeParse({
      zhongYaoName: "  人参  ",
      zhongYaoBeiMing: "  棒槌  ",
      zhongYaoText: "  人参，味甘微寒。  ", // 内容不 trim（标记/换行是内容本体）
      zhongYaoList: ["棒槌", "人衔"],
      isEnable: false,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.zhongYaoName).toBe("人参");
      expect(parsed.data.zhongYaoBeiMing).toBe("棒槌");
      expect(parsed.data.zhongYaoText).toBe("  人参，味甘微寒。  "); // 未 trim
      expect(parsed.data.isEnable).toBe(false);
    }
  });

  it("update schema makes every field optional but keeps non-null fields non-null", () => {
    const parsed = zhongYaoUpdateSchema.safeParse({zhongYaoName: "黄芪"});
    expect(parsed.success).toBe(true);
    // 非空列更新时不可写成 null
    expect(
      zhongYaoUpdateSchema.safeParse({zhongYaoName: null}).success,
    ).toBe(false);
    expect(
      zhongYaoUpdateSchema.safeParse({zhongYaoText: null}).success,
    ).toBe(false);
  });
});

describe("zhong_yao handlers", () => {
  it("create handler rejects invalid input with AppError 400", async () => {
    const db = emptyDatabase();
    await expect(
      createZhongYaoHandler(db, {zhongYaoName: ""}),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("create handler persists a valid herb and reads it back on the board", async () => {
    const db = emptyDatabase();
    const created = await createZhongYaoHandler(db, {
      zhongYaoName: "人参",
      zhongYaoText: "人参，味甘微寒。主补五脏。",
      zhongYaoList: ["棒槌"],
    });
    expect(created.id).toHaveLength(11);
    expect(created.zhongYaoNo).toBe(0);
    const board = await listZhongYaoBoardHandler(db);
    expect(board.entries).toHaveLength(1);
    expect(board.entries[0]?.id).toBe(created.id);
  });

  it("update handler 404s on a missing id and 400s on an empty patch", async () => {
    const db = emptyDatabase();
    await expect(
      updateZhongYaoHandler(db, "missing1", {zhongYaoName: "黄芪"}),
    ).rejects.toMatchObject({status: 404, i18nKey: ZHONG_YAO_ERRORS.notFound});
    // 空 patch（所有字段 undefined）→ 400
    const created = await createZhongYaoHandler(db, {
      zhongYaoName: "人参",
      zhongYaoText: "内容",
    });
    await expect(
      updateZhongYaoHandler(db, created.id, {}),
    ).rejects.toMatchObject({status: 400, i18nKey: ZHONG_YAO_ERRORS.invalidInput});
  });

  it("update handler persists a partial patch and preserves untouched fields", async () => {
    const db = emptyDatabase();
    const created = await createZhongYaoHandler(db, {
      zhongYaoName: "黄芪",
      zhongYaoText: "黄芪，味甘微温。",
      zhongYaoBeiMing: "黄耆",
    });
    const updated = await updateZhongYaoHandler(db, created.id, {
      zhongYaoName: "黄芪（改）",
    });
    expect(updated.zhongYaoName).toBe("黄芪（改）");
    expect(updated.zhongYaoBeiMing).toBe("黄耆"); // 未 touch 保留
  });

  it("delete handler 404s on a missing id", async () => {
    const db = emptyDatabase();
    await expect(
      deleteZhongYaoHandler(db, "missing1"),
    ).rejects.toMatchObject({status: 404});
  });

  it("purge handler 409s on an un-deleted row and succeeds after soft delete", async () => {
    const db = emptyDatabase();
    const created = await createZhongYaoHandler(db, {
      zhongYaoName: "人参",
      zhongYaoText: "内容",
    });
    await expect(
      purgeZhongYaoHandler(db, created.id),
    ).rejects.toMatchObject({status: 409, i18nKey: ZHONG_YAO_ERRORS.purgeNeedsDelete});

    await deleteZhongYaoHandler(db, created.id);
    await expect(purgeZhongYaoHandler(db, created.id)).resolves.toEqual({
      purged: true,
    });
  });
});
