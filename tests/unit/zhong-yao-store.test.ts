import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {SqliteStatement} from "./support/sqlite-statement";
import {
  createZhongYao,
  getZhongYao,
  loadZhongYaoBoard,
  purgeZhongYao,
  softDeleteZhongYao,
  updateZhongYao,
} from "@/server/zhong-yao/store";
import type {
  ZhongYaoDb,
  ZhongYaoDbPreparedStatement,
} from "@/server/zhong-yao/types";



class SqliteZhongYaoDb implements ZhongYaoDb {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): ZhongYaoDbPreparedStatement {
    return new SqliteStatement(this.database, query);
  }
}

/** 镜像迁移 0180 的 `zhong_yao` DDL（含 UNIQUE(zhong_yao_no)），供端口级往返测试。
 *  无分组、无来源书、无 settings——本草是平铺独立表（ADR-0061 决策 2/3）。 */
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

describe("zhong_yao store round-trip", () => {
  it("creates, reads and lists a row; zhong_yao_no is MAX+1", async () => {
    const db = emptyDatabase();
    const created = await createZhongYao(db, "zy000000001", {
      zhongYaoName: "人参",
      zhongYaoText: "人参，味甘微寒。主补五脏。",
      zhongYaoList: ["棒槌"],
      isEnable: true,
    });
    expect(created.id).toBe("zy000000001");
    expect(created.zhongYaoNo).toBe(0); // 空表 → MAX+1 = 0
    expect(created.zhongYaoName).toBe("人参");
    expect(created.zhongYaoList).toEqual(["棒槌"]);
    expect(created.isEnable).toBe(true);
    expect(created.isDeleted).toBe(false);

    const loaded = await getZhongYao(db, created.id);
    expect(loaded?.zhongYaoName).toBe("人参");

    const board = await loadZhongYaoBoard(db);
    expect(board).toHaveLength(1);
    expect(board[0]?.id).toBe(created.id);
  });

  it("next zhong_yao_no continues after a seeded max", async () => {
    const db = emptyDatabase();
    // 预置种子 max=171 的一行，新行的 no 应 = 172。
    await db.prepare(
      "INSERT INTO zhong_yao (id, zhong_yao_no, zhong_yao_name, zhong_yao_text) " +
        "VALUES (?, ?, ?, ?)",
    ).bind("seedmax01", 171, "种子", "内容").run();
    const created = await createZhongYao(db, "zy000000002", {
      zhongYaoName: "新本草",
      zhongYaoText: "内容",
    });
    expect(created.zhongYaoNo).toBe(172);
  });

  it("updates with a partial patch and preserves untouched fields", async () => {
    const db = emptyDatabase();
    const created = await createZhongYao(db, "zy000000003", {
      zhongYaoName: "黄芪",
      zhongYaoText: "黄芪，味甘微温。主痈疽。",
      zhongYaoBeiMing: "黄耆",
      isEnable: true,
    });
    const updated = await updateZhongYao(db, created.id, {
      zhongYaoName: "黄芪（改）",
      isEnable: false,
    });
    expect(updated?.zhongYaoName).toBe("黄芪（改）");
    expect(updated?.zhongYaoBeiMing).toBe("黄耆"); // 未 touch 的字段保留
    expect(updated?.isEnable).toBe(false);
    expect(updated?.isDeleted).toBe(false);
  });

  it("update clears a nullable field when the patch explicitly passes null", async () => {
    const db = emptyDatabase();
    const created = await createZhongYao(db, "zy000000004", {
      zhongYaoName: "甘草",
      zhongYaoText: "甘草，味甘平。主五脏六腑。",
      zhongYaoBeiMing: "国老",
    });
    const updated = await updateZhongYao(db, created.id, {
      zhongYaoBeiMing: null, // 显式清空
    });
    expect(updated?.zhongYaoBeiMing).toBeNull();
  });

  it("soft deletes then purges; purge refuses an un-deleted row", async () => {
    const db = emptyDatabase();
    const created = await createZhongYao(db, "zy000000005", {
      zhongYaoName: "当归",
      zhongYaoText: "当归，味甘温。主咳逆上气。",
    });

    // 未软删 → 物删被拒
    await expect(purgeZhongYao(db, created.id)).resolves.toEqual({
      purged: false,
      reason: "notDeleted",
    });

    // 软删 → 行保留但 isDeleted
    expect(await softDeleteZhongYao(db, created.id)).toBe(true);
    const softDeleted = await getZhongYao(db, created.id);
    expect(softDeleted?.isDeleted).toBe(true);
    // 已软删不再重复软删
    expect(await softDeleteZhongYao(db, created.id)).toBe(false);

    // 物删
    await expect(purgeZhongYao(db, created.id)).resolves.toEqual({purged: true});
    expect(await getZhongYao(db, created.id)).toBeNull();
    await expect(purgeZhongYao(db, created.id)).resolves.toEqual({
      purged: false,
      reason: "missing",
    });
  });

  it("board flags a soft-deleted row so the UI can offer purge", async () => {
    const db = emptyDatabase();
    const created = await createZhongYao(db, "zy000000006", {
      zhongYaoName: "白术",
      zhongYaoText: "白术，味苦温。主风寒湿痹。",
    });
    await softDeleteZhongYao(db, created.id);
    const board = await loadZhongYaoBoard(db);
    expect(board).toHaveLength(1);
    expect(board[0]?.isDeleted).toBe(true);
  });

  it("stores zhong_yao_list as plain comma text and parses it back", async () => {
    const db = emptyDatabase();
    const created = await createZhongYao(db, "zy000000007", {
      zhongYaoName: "茯苓",
      zhongYaoText: "茯苓，味甘平。主胸胁逆气。",
      zhongYaoList: ["茯灵", "伏菟"],
    });
    expect(created.zhongYaoList).toEqual(["茯灵", "伏菟"]);
    // DB 列里是纯逗号文本（对齐 netcore YaoList 落库形态）。
    const row = await db.prepare(
      "SELECT zhong_yao_list FROM zhong_yao WHERE id = ?",
    ).bind(created.id).first();
    expect(String(row?.zhong_yao_list)).toBe("茯灵,伏菟");
  });

  it("stores $u{}/$q{} markers and literal \\r\\n verbatim (no escaping/parsing)", async () => {
    const db = emptyDatabase();
    const text = "气味：$u{甘}$q{平}。主治：$u{补中}$q{益气}。\r\n又主渴。";
    const created = await createZhongYao(db, "zy000000008", {
      zhongYaoName: "地黄",
      zhongYaoText: text,
    });
    expect(created.zhongYaoText).toBe(text);
  });

  it("board sorts by zhong_yao_no (seed order preserved)", async () => {
    const db = emptyDatabase();
    // 乱序插入，验证排序键是 zhong_yao_no 而非插入顺序。
    await createZhongYao(db, "zy000000009", {zhongYaoName: "C", zhongYaoText: "c"});
    await createZhongYao(db, "zy000000010", {zhongYaoName: "A", zhongYaoText: "a"});
    await createZhongYao(db, "zy000000011", {zhongYaoName: "B", zhongYaoText: "b"});
    const board = await loadZhongYaoBoard(db);
    expect(board.map((row) => row.zhongYaoName)).toEqual(["C", "A", "B"]);
    expect(board.map((row) => row.zhongYaoNo)).toEqual([0, 1, 2]);
  });

  it("zhong_yao_no is unique: a conflict on the same MAX+1 fails fast", async () => {
    const db = emptyDatabase();
    await createZhongYao(db, "zy000000012", {zhongYaoName: "独", zhongYaoText: "x"});
    // 手工插入同 no（绕过 MAX+1），验证 UNIQUE 约束兜底。
    await expect(
      db.prepare(
        "INSERT INTO zhong_yao (id, zhong_yao_no, zhong_yao_name, zhong_yao_text) " +
          "VALUES (?, ?, ?, ?)",
      ).bind("zy000000013", 0, "撞号", "y").run(),
    ).rejects.toThrow(/UNIQUE/u);
  });
});
