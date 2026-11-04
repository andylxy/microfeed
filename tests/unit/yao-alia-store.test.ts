import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {
  createYaoAlia,
  getYaoAlia,
  loadYaoAliaBoard,
  purgeYaoAlia,
  softDeleteYaoAlia,
  updateYaoAlia,
} from "@/server/yao-alia/store";
import type {
  YaoAliaDb,
  YaoAliaDbAllResult,
  YaoAliaDbPreparedStatement,
} from "@/server/yao-alia/types";

type SqlInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;

class SqliteStatement implements YaoAliaDbPreparedStatement {
  private readonly statement: ReturnType<DatabaseSync["prepare"]>;
  private values: SqlInputValue[] = [];

  constructor(database: DatabaseSync, query: string) {
    this.statement = database.prepare(query);
  }

  bind(...values: unknown[]): YaoAliaDbPreparedStatement {
    this.values = values as SqlInputValue[];
    return this;
  }

  async all(): Promise<YaoAliaDbAllResult> {
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

class SqliteYaoAliaDb implements YaoAliaDb {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): YaoAliaDbPreparedStatement {
    return new SqliteStatement(this.database, query);
  }
}

/** 镜像迁移 0183 的 `yao_alia` DDL（含两条 UNIQUE 索引），供端口级往返测试。
 *  无分组表、无 settings、无来源书——分组是 UI 按 `yao_alia_name` 只读派生。 */
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

describe("yao_alia store round-trip", () => {
  it("creates, reads and lists a row; yao_alia_no is MAX+1", async () => {
    const db = emptyDatabase();
    const created = await createYaoAlia(db, "ya0000000x1", {
      bieMing: "术",
      yaoName: "白术",
    });
    expect(created.id).toBe("ya0000000x1");
    expect(created.yaoAliaNo).toBe(1); // 空表 → COALESCE(MAX, 0) + 1 = 1（与 0183 种子从 1 起一致）
    expect(created.bieMing).toBe("术");
    expect(created.yaoName).toBe("白术");
    expect(created.isEnable).toBe(true);
    expect(created.isDeleted).toBe(false);
    // signature_id / signature 列位保留、admin 不编辑：新建不写，读到 null。
    expect(created.signatureId).toBeNull();
    expect(created.signature).toBeNull();

    const loaded = await getYaoAlia(db, created.id);
    expect(loaded?.bieMing).toBe("术");

    const board = await loadYaoAliaBoard(db);
    expect(board).toHaveLength(1);
    expect(board[0]?.id).toBe(created.id);
  });

  it("next yao_alia_no continues after the seeded max (47 → 48)", async () => {
    const db = emptyDatabase();
    // 预置种子 max=47 的一行，新行的 no 应 = 48。
    await db.prepare(
      "INSERT INTO yao_alia (id, yao_alia_no, yao_alia_bie_ming, yao_alia_name) " +
        "VALUES (?, ?, ?, ?)",
    ).bind("ya00000047", 47, "硝石", "赤消").run();
    const created = await createYaoAlia(db, "ya000000048", {
      bieMing: "新增别名",
      yaoName: "新增正名",
    });
    expect(created.yaoAliaNo).toBe(48);
  });

  it("board sorts by yao_alia_no and keeps seed order", async () => {
    const db = emptyDatabase();
    await createYaoAlia(db, "ya0000000a1", {bieMing: "枣", yaoName: "大枣"});
    await createYaoAlia(db, "ya0000000a2", {bieMing: "术", yaoName: "白术"});
    await createYaoAlia(db, "ya0000000a3", {bieMing: "桂", yaoName: "桂枝"});
    const board = await loadYaoAliaBoard(db);
    expect(board.map((row) => row.bieMing)).toEqual(["枣", "术", "桂"]);
    expect(board.map((row) => row.yaoAliaNo)).toEqual([0, 1, 2]);
  });

  it("keeps several aliases under one canonical name (name is not UNIQUE)", async () => {
    const db = emptyDatabase();
    await createYaoAlia(db, "ya0000000b1", {bieMing: "术", yaoName: "白术"});
    await createYaoAlia(db, "ya0000000b2", {bieMing: "朮", yaoName: "白术"});
    await createYaoAlia(db, "ya0000000b3", {bieMing: "白朮", yaoName: "白术"});
    const board = await loadYaoAliaBoard(db);
    // 左栏分组正是靠这条：同一正名下可挂多条别名（源 30 个正名 / 47 行）。
    expect(board.filter((row) => row.yaoName === "白术")).toHaveLength(3);
  });

  it("rejects a duplicate alias fast (UNIQUE on yao_alia_bie_ming)", async () => {
    const db = emptyDatabase();
    await createYaoAlia(db, "ya0000000c1", {bieMing: "术", yaoName: "白术"});
    await expect(
      createYaoAlia(db, "ya0000000c2", {bieMing: "术", yaoName: "苍术"}),
    ).rejects.toThrow(/UNIQUE/u);
  });

  it("updates with a partial patch and preserves untouched fields", async () => {
    const db = emptyDatabase();
    const created = await createYaoAlia(db, "ya0000000d1", {
      bieMing: "桂心",
      yaoName: "桂枝",
    });
    const updated = await updateYaoAlia(db, created.id, {yaoName: "肉桂"});
    expect(updated?.yaoName).toBe("肉桂");
    expect(updated?.bieMing).toBe("桂心"); // 未 touch 的字段保留
    expect(updated?.isEnable).toBe(true);
    expect(updated?.yaoAliaNo).toBe(created.yaoAliaNo); // 序号不因编辑而变
  });

  it("update toggles is_enable and writes it back as 0/1", async () => {
    const db = emptyDatabase();
    const created = await createYaoAlia(db, "ya0000000d2", {
      bieMing: "枣膏",
      yaoName: "大枣",
    });
    const disabled = await updateYaoAlia(db, created.id, {isEnable: false});
    expect(disabled?.isEnable).toBe(false);
    const row = await db.prepare(
      "SELECT is_enable FROM yao_alia WHERE id = ?",
    ).bind(created.id).first();
    expect(Number(row?.is_enable)).toBe(0);
  });

  it("returns null when updating or reading a missing row", async () => {
    const db = emptyDatabase();
    await expect(updateYaoAlia(db, "no-such-id", {yaoName: "x"})).resolves.toBeNull();
    await expect(getYaoAlia(db, "no-such-id")).resolves.toBeNull();
  });

  it("soft deletes then purges; purge refuses an un-deleted row", async () => {
    const db = emptyDatabase();
    const created = await createYaoAlia(db, "ya0000000e1", {
      bieMing: "法醋",
      yaoName: "苦酒",
    });

    // 未软删 → 物删被拒（两步删除的第二段只对已软删行开放）
    await expect(purgeYaoAlia(db, created.id)).resolves.toEqual({
      purged: false,
      reason: "notDeleted",
    });

    // 软删 → 行保留但 isDeleted
    expect(await softDeleteYaoAlia(db, created.id)).toBe(true);
    const softDeleted = await getYaoAlia(db, created.id);
    expect(softDeleted?.isDeleted).toBe(true);
    // 已软删不再重复软删
    expect(await softDeleteYaoAlia(db, created.id)).toBe(false);
    // 软删行仍在看板里（右栏靠 isDeleted 给「物删」入口）
    expect((await loadYaoAliaBoard(db))[0]?.isDeleted).toBe(true);

    // 物删
    await expect(purgeYaoAlia(db, created.id)).resolves.toEqual({purged: true});
    expect(await getYaoAlia(db, created.id)).toBeNull();
    await expect(purgeYaoAlia(db, created.id)).resolves.toEqual({
      purged: false,
      reason: "missing",
    });
  });

  it("a soft-deleted row still occupies the alias unique key", async () => {
    const db = emptyDatabase();
    const created = await createYaoAlia(db, "ya0000000f1", {
      bieMing: "葱白",
      yaoName: "葱",
    });
    await softDeleteYaoAlia(db, created.id);
    // 软删 ≠ 释放唯一键：要复用同名别名必须先在「已删除」里物删该行。
    await expect(
      createYaoAlia(db, "ya0000000f2", {bieMing: "葱白", yaoName: "葱"}),
    ).rejects.toThrow(/UNIQUE/u);
    // 物删之后同名别名才可再建。
    await purgeYaoAlia(db, created.id);
    const recreated = await createYaoAlia(db, "ya0000000f3", {
      bieMing: "葱白",
      yaoName: "葱",
    });
    expect(recreated.bieMing).toBe("葱白");
  });

  it("stores text verbatim (no trim / no normalization in the store)", async () => {
    const db = emptyDatabase();
    // store 不做格式归一：首尾空格、全角字符、$m{} 标记都原样落库。
    // 人工输入的 trim 在 Zod 层（schema），导入数据在迁移 SQL 里就已经是原样。
    const bieMing = " 大麦粥汁 ";
    const created = await createYaoAlia(db, "ya0000000g1", {
      bieMing,
      yaoName: "大麦",
    });
    expect(created.bieMing).toBe(bieMing);
  });
});
