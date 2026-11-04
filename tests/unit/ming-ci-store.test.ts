import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {
  createMingCi,
  getMingCi,
  loadMingCiBoard,
  purgeMingCi,
  reassignMingCiType,
  softDeleteMingCi,
  updateMingCi,
} from "@/server/ming-ci/store";
import type {
  MingCiDb,
  MingCiDbAllResult,
  MingCiDbPreparedStatement,
} from "@/server/ming-ci/types";

type SqlInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;

class SqliteStatement implements MingCiDbPreparedStatement {
  private readonly statement: ReturnType<DatabaseSync["prepare"]>;
  private values: SqlInputValue[] = [];

  constructor(database: DatabaseSync, query: string) {
    this.statement = database.prepare(query);
  }

  bind(...values: unknown[]): MingCiDbPreparedStatement {
    this.values = values as SqlInputValue[];
    return this;
  }

  async all(): Promise<MingCiDbAllResult> {
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

class SqliteMingCiDb implements MingCiDb {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): MingCiDbPreparedStatement {
    return new SqliteStatement(this.database, query);
  }
}

/** 镜像迁移 0177 的 `ming_ci` DDL（含 UNIQUE(ming_ci_no)），供端口级往返测试。 */
function emptyDatabase(): SqliteMingCiDb {
  const database = new DatabaseSync(":memory:");
  database.exec(`
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

describe("ming_ci store round-trip", () => {
  it("creates, reads and lists a row; ming_ci_no is MAX+1", async () => {
    const db = emptyDatabase();
    const created = await createMingCi(db, "mingci001", {
      mingCiName: "阴阳",
      mingCiType: "yili",
      mingCiText: "阴阳者，天地之道也。",
      mingCiList: ["阴阳学说"],
      sourceBookId: "XNK0VFX39Xv",
      isEnable: true,
    });
    expect(created.id).toBe("mingci001");
    expect(created.mingCiNo).toBe(0); // 空表 → MAX+1 = 0
    expect(created.mingCiName).toBe("阴阳");
    expect(created.mingCiType).toBe("yili");
    expect(created.mingCiList).toEqual(["阴阳学说"]);
    expect(created.sourceBookId).toBe("XNK0VFX39Xv");
    expect(created.isEnable).toBe(true);
    expect(created.isDeleted).toBe(false);

    const loaded = await getMingCi(db, created.id);
    expect(loaded?.mingCiName).toBe("阴阳");

    const board = await loadMingCiBoard(db);
    expect(board).toHaveLength(1);
    expect(board[0]?.id).toBe(created.id);
  });

  it("next ming_ci_no continues after a seeded max", async () => {
    const db = emptyDatabase();
    // 预置种子 max=16 的一行，新行的 no 应 = 17。
    await db.prepare(
      "INSERT INTO ming_ci (id, ming_ci_no, ming_ci_name, ming_ci_text, ming_ci_type) " +
        "VALUES (?, ?, ?, ?, ?)",
    ).bind("seedmax1", 16, "种子", "内容", "yili").run();
    const created = await createMingCi(db, "mingci002", {
      mingCiName: "新名词",
      mingCiType: "yili",
      mingCiText: "内容",
    });
    expect(created.mingCiNo).toBe(17);
  });

  it("updates with a partial patch and preserves untouched fields", async () => {
    const db = emptyDatabase();
    const created = await createMingCi(db, "mingci003", {
      mingCiName: "五行",
      mingCiType: "yili",
      mingCiText: "木火土金水",
      mingCiBeiMing: "五运",
      isEnable: true,
    });
    const updated = await updateMingCi(db, created.id, {
      mingCiName: "五行学说",
      isEnable: false,
    });
    expect(updated?.mingCiName).toBe("五行学说");
    expect(updated?.mingCiBeiMing).toBe("五运"); // 未 touch 的字段保留
    expect(updated?.mingCiType).toBe("yili");
    expect(updated?.isEnable).toBe(false);
    expect(updated?.isDeleted).toBe(false);
  });

  it("update clears a nullable field when the patch explicitly passes null", async () => {
    const db = emptyDatabase();
    const created = await createMingCi(db, "mingci004", {
      mingCiName: "卫气",
      mingCiType: "yaoli",
      mingCiText: "卫气者，水谷之悍气也。",
      mingCiBeiMing: "卫阳",
    });
    const updated = await updateMingCi(db, created.id, {
      mingCiBeiMing: null, // 显式清空
    });
    expect(updated?.mingCiBeiMing).toBeNull();
  });

  it("soft deletes then purges; purge refuses an un-deleted row", async () => {
    const db = emptyDatabase();
    const created = await createMingCi(db, "mingci005", {
      mingCiName: "营血",
      mingCiType: "yaoli",
      mingCiText: "营血者，濡养周身。",
    });

    // 未软删 → 物删被拒
    await expect(purgeMingCi(db, created.id)).resolves.toEqual({
      purged: false,
      reason: "notDeleted",
    });

    // 软删 → 行保留但 isDeleted
    expect(await softDeleteMingCi(db, created.id)).toBe(true);
    const softDeleted = await getMingCi(db, created.id);
    expect(softDeleted?.isDeleted).toBe(true);
    // 已软删不再重复软删
    expect(await softDeleteMingCi(db, created.id)).toBe(false);

    // 物删
    await expect(purgeMingCi(db, created.id)).resolves.toEqual({purged: true});
    expect(await getMingCi(db, created.id)).toBeNull();
    await expect(purgeMingCi(db, created.id)).resolves.toEqual({
      purged: false,
      reason: "missing",
    });
  });

  it("board flags a soft-deleted row so the UI can offer purge", async () => {
    const db = emptyDatabase();
    const created = await createMingCi(db, "mingci006", {
      mingCiName: "津液",
      mingCiType: "yili",
      mingCiText: "津液者，水谷所化。",
    });
    await softDeleteMingCi(db, created.id);
    const board = await loadMingCiBoard(db);
    expect(board).toHaveLength(1);
    expect(board[0]?.isDeleted).toBe(true);
  });

  it("reassigns every noun of a group to the target group", async () => {
    const db = emptyDatabase();
    await createMingCi(db, "mingci007", {
      mingCiName: "甲",
      mingCiType: "yili",
      mingCiText: "内容甲",
    });
    await createMingCi(db, "mingci008", {
      mingCiName: "乙",
      mingCiType: "yili",
      mingCiText: "内容乙",
    });
    await createMingCi(db, "mingci009", {
      mingCiName: "丙",
      mingCiType: "yaoli",
      mingCiText: "内容丙",
    });
    await reassignMingCiType(db, "yili", "yaoli");
    const board = await loadMingCiBoard(db);
    const byType = (type: string) => board.filter((row) => row.mingCiType === type);
    expect(byType("yili")).toHaveLength(0);
    expect(byType("yaoli")).toHaveLength(3);
  });

  it("serializes ming_ci_list as a JSON array and parses it back", async () => {
    const db = emptyDatabase();
    const created = await createMingCi(db, "mingci010", {
      mingCiName: "藏象",
      mingCiType: "yili",
      mingCiText: "藏象者，藏于内、象于外。",
      mingCiList: ["脏腑", "脏象"],
    });
    expect(created.mingCiList).toEqual(["脏腑", "脏象"]);
    // DB 列里是 JSON 数组字符串（镜像 App 形状）。
    const row = await db.prepare(
      "SELECT ming_ci_list FROM ming_ci WHERE id = ?",
    ).bind(created.id).first();
    expect(JSON.parse(String(row?.ming_ci_list))).toEqual(["脏腑", "脏象"]);
  });

  it("stores $m{}/$n{}/$x{}/$a{} markers verbatim (no escaping/parsing)", async () => {
    const db = emptyDatabase();
    const text = "方：$m{桂枝}$n{白芍}$x{炙甘草}$a{大枣}";
    const created = await createMingCi(db, "mingci011", {
      mingCiName: "桂枝汤",
      mingCiType: "yaoli",
      mingCiText: text,
    });
    expect(created.mingCiText).toBe(text);
  });

  it("board sorts by ming_ci_no (seed order preserved)", async () => {
    const db = emptyDatabase();
    // 乱序插入，验证排序键是 ming_ci_no 而非插入顺序。
    await createMingCi(db, "mingci012", {mingCiName: "C", mingCiType: "分", mingCiText: "c"});
    await createMingCi(db, "mingci013", {mingCiName: "A", mingCiType: "分", mingCiText: "a"});
    await createMingCi(db, "mingci014", {mingCiName: "B", mingCiType: "分", mingCiText: "b"});
    const board = await loadMingCiBoard(db);
    expect(board.map((row) => row.mingCiName)).toEqual(["C", "A", "B"]);
    expect(board.map((row) => row.mingCiNo)).toEqual([0, 1, 2]);
  });

  it("ming_ci_no is unique: a conflict on the same MAX+1 fails fast", async () => {
    const db = emptyDatabase();
    await createMingCi(db, "mingci015", {mingCiName: "独", mingCiType: "分", mingCiText: "x"});
    // 手工插入同 no（绕过 MAX+1），验证 UNIQUE 约束兜底。
    await expect(
      db.prepare(
        "INSERT INTO ming_ci (id, ming_ci_no, ming_ci_name, ming_ci_text, ming_ci_type) " +
          "VALUES (?, ?, ?, ?, ?)",
      ).bind("mingci016", 0, "撞号", "y", "分").run(),
    ).rejects.toThrow(/UNIQUE/u);
  });
});
