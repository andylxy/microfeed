import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {SqliteStatement} from "./support/sqlite-statement";
import {
  countBodiesByFang,
  createFangYao,
  createFangYaoBody,
  getFangYao,
  getFangYaoBody,
  listBodiesByFang,
  loadFangYaoBoard,
  purgeFangYao,
  purgeFangYaoBody,
  softDeleteFangYao,
  softDeleteFangYaoBody,
  updateFangYao,
  updateFangYaoBody,
} from "@/server/fang-yao/store";
import type {
  FangYaoDb,
  FangYaoDbPreparedStatement,
} from "@/server/fang-yao/types";



class SqliteFangYaoDb implements FangYaoDb {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): FangYaoDbPreparedStatement {
    return new SqliteStatement(this.database, query);
  }
}

/** 镜像迁移 0184 的两表 DDL（含 UNIQUE(source_book_legacy_id, fang_no) 与
 *  UNIQUE(fang_yao_id, position)），供端口级往返测试。 */
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
    CREATE INDEX fang_yao_name ON fang_yao (fang_name);
    CREATE INDEX fang_yao_source_book ON fang_yao (source_book_legacy_id);
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

describe("fang_yao store round-trip", () => {
  it("creates, reads and lists a formula; fang_no is MAX+1 within its source book", async () => {
    const db = emptyDatabase();
    const created = await createFangYao(db, "fang00000001", {
      fangName: "桂枝汤",
      sourceBookLegacyId: "10001",
      sourceBookName: "伤寒金匮・(宋版)",
      fangText: "$u{桂枝}$w{三两}",
      isEnable: true,
    });
    expect(created.id).toBe("fang00000001");
    expect(created.fangNo).toBe(1); // 空表 → MAX+1 = 1
    expect(created.fangName).toBe("桂枝汤");
    expect(created.sourceBookLegacyId).toBe("10001");
    expect(created.sourceBookName).toBe("伤寒金匮・(宋版)");
    expect(created.isEnable).toBe(true);
    expect(created.isDeleted).toBe(false);
    expect(created.yaoCount).toBe(0); // 读侧 COUNT 派生，无组成时 0

    const loaded = await getFangYao(db, created.id);
    expect(loaded?.fangName).toBe("桂枝汤");

    const board = await loadFangYaoBoard(db);
    expect(board).toHaveLength(1);
    expect(board[0]?.id).toBe(created.id);
    expect(board[0]?.yaoCount).toBe(0);
  });

  it("continues fang_no in the same source book but resets to 1 in another", async () => {
    const db = emptyDatabase();
    const first = await createFangYao(db, "fang00000002", {
      fangName: "麻黄汤",
      sourceBookLegacyId: "10001",
      fangText: "$u{麻黄}$w{三两}",
    });
    expect(first.fangNo).toBe(1);

    const second = await createFangYao(db, "fang00000003", {
      fangName: "葛根汤",
      sourceBookLegacyId: "10001",
      fangText: "$u{葛根}$w{四两}",
    });
    expect(second.fangNo).toBe(2); // 同组 → MAX+1 = 2

    // 换源书组从 1 重开（P1 甲：组内连续，跨组独立）
    const other = await createFangYao(db, "fang00000004", {
      fangName: "小柴胡汤",
      sourceBookLegacyId: "1001000",
      fangText: "$u{柴胡}$w{半斤}",
    });
    expect(other.fangNo).toBe(1);
  });

  it("keeps fang_text byte-for-byte (leading spaces, LF, TAB, markers)", async () => {
    const db = emptyDatabase();
    // 源方文真实形态：前导缩进 + 真实换行 + 制表符 + $u{}/$w{} 标记。
    const fangText = "  $u{桂枝}$w{三两}  \n\t$u{芍药}$w{三两}  \n  $u{甘草}$w{二两}  ";
    const created = await createFangYao(db, "fang00000005", {
      fangName: "桂枝汤",
      fangText,
    });
    // 写入即保真（零 trim）
    expect(created.fangText).toBe(fangText);
    expect(created.fangText).toContain("\n");
    expect(created.fangText).toContain("\t");
    expect(created.fangText).toContain("$u{桂枝}");

    // 读回仍逐字符一致
    const loaded = await getFangYao(db, created.id);
    expect(loaded?.fangText).toBe(fangText);
  });

  it("keeps a formula name with leading and trailing spaces untouched", async () => {
    const db = emptyDatabase();
    const name = "  桂枝汤  ";
    const created = await createFangYao(db, "fang00000006", {
      fangName: name,
      fangText: "$u{桂枝}",
    });
    expect(created.fangName).toBe(name);

    const loaded = await getFangYao(db, created.id);
    expect(loaded?.fangName).toBe(name);
  });

  it("updates with a partial patch and preserves untouched fields", async () => {
    const db = emptyDatabase();
    const created = await createFangYao(db, "fang00000007", {
      fangName: "五苓散",
      sourceBookLegacyId: "1001000",
      sourceBookName: "伤寒杂病论・(桂林古本)",
      fangText: "$u{猪苓}$w{十八铢}",
      isEnable: true,
    });
    const updated = await updateFangYao(db, created.id, {
      fangName: "五苓散(改)",
      isEnable: false,
    });
    expect(updated?.fangName).toBe("五苓散(改)");
    expect(updated?.sourceBookLegacyId).toBe("1001000"); // 未 touch 的字段保留
    expect(updated?.fangText).toBe("$u{猪苓}$w{十八铢}");
    expect(updated?.isEnable).toBe(false);
    expect(updated?.isDeleted).toBe(false);
  });

  it("update preserves the read-only source-book fields even when the patch passes null", async () => {
    const db = emptyDatabase();
    const created = await createFangYao(db, "fang00000008", {
      fangName: "白虎汤",
      sourceBookLegacyId: "10002",
      fangText: "$u{石膏}$w{一斤}",
    });
    // sourceBookLegacyId/sourceBookName 只读（ADR-0065）：编辑不改写，防 fang_no
    // 随行移入他组撞 UNIQUE。创建后显式传 null 应被忽略、保留原组。
    const updated = await updateFangYao(db, created.id, {
      sourceBookLegacyId: null,
      sourceBookName: null,
    });
    expect(updated?.sourceBookLegacyId).toBe("10002");
    expect(updated?.sourceBookName).toBeNull();
  });

  it("update keeps fang_text verbatim (no re-balancing)", async () => {
    const db = emptyDatabase();
    const text = "  原方文带缩进。\n$u{桂枝}$w{三两}  ";
    const created = await createFangYao(db, "fang00000009", {
      fangName: "桂枝汤",
      fangText: text,
    });
    // 只改 isEnable，fangText 原样保留——读写层不再改写花括号
    const updated = await updateFangYao(db, created.id, {isEnable: false});
    expect(updated?.fangText).toBe(text);
  });

  it("soft deletes then purges; purge refuses an un-deleted row", async () => {
    const db = emptyDatabase();
    const created = await createFangYao(db, "fang00000010", {
      fangName: "半夏汤",
      fangText: "$u{半夏}",
    });

    // 未软删直接物删 → notDeleted
    const refused = await purgeFangYao(db, created.id);
    expect(refused.purged).toBe(false);
    if (!refused.purged) expect(refused.reason).toBe("notDeleted");

    expect(await softDeleteFangYao(db, created.id)).toBe(true);
    // 重复软删返回 false
    expect(await softDeleteFangYao(db, created.id)).toBe(false);

    const after = await getFangYao(db, created.id);
    expect(after?.isDeleted).toBe(true);

    const purged = await purgeFangYao(db, created.id);
    expect(purged.purged).toBe(true);
    expect(await getFangYao(db, created.id)).toBeNull();
  });

  it("purge reports missing for an unknown id", async () => {
    const db = emptyDatabase();
    const result = await purgeFangYao(db, "nope0000000");
    expect(result.purged).toBe(false);
    if (!result.purged) expect(result.reason).toBe("missing");
  });

  it("purge refuses while the formula still has bodies (no orphan rows)", async () => {
    const db = emptyDatabase();
    const fang = await createFangYao(db, "fang00000011", {
      fangName: "桂枝加葛根汤",
      fangText: "$u{桂枝}",
    });
    const body = await createFangYaoBody(db, "body00000001", fang.id, {
      showName: "桂枝",
      amount: "三两",
    });

    expect(await softDeleteFangYao(db, fang.id)).toBe(true);
    const refused = await purgeFangYao(db, fang.id);
    expect(refused.purged).toBe(false);
    if (!refused.purged) expect(refused.reason).toBe("hasBodies");
    // 方剂还在，组成引用不悬空
    expect(await getFangYao(db, fang.id)).not.toBeNull();
    expect(await getFangYaoBody(db, body.id)).not.toBeNull();

    // 删掉组成后方剂才能物删
    expect(await softDeleteFangYaoBody(db, body.id)).toBe(true);
    expect((await purgeFangYaoBody(db, body.id)).purged).toBe(true);
    expect((await purgeFangYao(db, fang.id)).purged).toBe(true);
  });

  it("fang_no is unique within a source book: a conflict fails fast", async () => {
    const db = emptyDatabase();
    const first = await createFangYao(db, "fang00000012", {
      fangName: "麻黄汤",
      sourceBookLegacyId: "10001",
      fangText: "$u{麻黄}",
    });
    // 手工插入同组同 no（绕过 MAX+1），验证 UNIQUE 约束兜底。
    await expect(
      db.prepare(
        "INSERT INTO fang_yao (id, fang_no, fang_name, source_book_legacy_id, fang_text) " +
          "VALUES (?, ?, ?, ?, ?)",
      ).bind("fang00000013", first.fangNo, "撞号", "10001", "$u{撞}").run(),
    ).rejects.toThrow(/UNIQUE/u);
  });

  it("nextFangNo uses IS ? so NULL source book groups are isolated", async () => {
    const db = emptyDatabase();
    // 无源书组（source_book_legacy_id 为 NULL）也按组独立计数
    const a = await createFangYao(db, "fang00000014", {
      fangName: "无源书组方一",
      fangText: "$u{一}",
    });
    expect(a.fangNo).toBe(1);
    const b = await createFangYao(db, "fang00000015", {
      fangName: "无源书组方二",
      fangText: "$u{二}",
    });
    expect(b.fangNo).toBe(2);
    // 有源书组的不受 NULL 组影响
    const c = await createFangYao(db, "fang00000016", {
      fangName: "有源书组方",
      sourceBookLegacyId: "9050000",
      fangText: "$u{三}",
    });
    expect(c.fangNo).toBe(1);
  });
});

describe("fang_yao_body store round-trip", () => {
  it("creates a body with position MAX+1 within its formula", async () => {
    const db = emptyDatabase();
    const fang = await createFangYao(db, "fang00010001", {
      fangName: "桂枝汤",
      fangText: "$u{桂枝}",
    });
    const first = await createFangYaoBody(db, "body00001001", fang.id, {
      showName: "桂枝",
      amount: "三两",
      isEnable: true,
    });
    expect(first.position).toBe(1);
    expect(first.fangYaoId).toBe(fang.id);
    expect(first.showName).toBe("桂枝");
    expect(first.amount).toBe("三两");
    expect(first.isDeleted).toBe(false);

    const second = await createFangYaoBody(db, "body00001002", fang.id, {
      showName: "芍药",
      amount: "三两",
    });
    expect(second.position).toBe(2);

    // position 按方隔离：另一方从 1 起
    const other = await createFangYao(db, "fang00010002", {
      fangName: "麻黄汤",
      fangText: "$u{麻黄}",
    });
    const otherFirst = await createFangYaoBody(db, "body00001003", other.id, {
      showName: "麻黄",
    });
    expect(otherFirst.position).toBe(1);
  });

  it("round-trips amount byte-for-byte (no trim, $x{} marker preserved)", async () => {
    const db = emptyDatabase();
    const fang = await createFangYao(db, "fang00010003", {
      fangName: "五苓散",
      fangText: "$u{猪苓}",
    });
    // 源数据真实形态：amount 内嵌 $x{} 标记 + 前导/行尾空格。
    const amount = "  $x{十八铢}  ";
    const created = await createFangYaoBody(db, "body00001004", fang.id, {
      showName: "猪苓",
      amount,
    });
    expect(created.amount).toBe(amount);
    expect(created.amount).toContain("$x{");

    const loaded = await getFangYaoBody(db, created.id);
    expect(loaded?.amount).toBe(amount);
  });

  it("update keeps text untouched when the patch does not carry it", async () => {
    const db = emptyDatabase();
    const fang = await createFangYao(db, "fang00010004", {
      fangName: "小柴胡汤",
      fangText: "$u{柴胡}",
    });
    const amount = "  半斤  ";
    const created = await createFangYaoBody(db, "body00001005", fang.id, {
      showName: "柴胡",
      amount,
      isEnable: true,
    });
    const updated = await updateFangYaoBody(db, created.id, {isEnable: false});
    expect(updated?.isEnable).toBe(false);
    expect(updated?.amount).toBe(amount); // 未被改写
  });

  it("update ignores an explicit position (system-managed)", async () => {
    const db = emptyDatabase();
    const fang = await createFangYao(db, "fang00010005", {
      fangName: "白虎汤",
      fangText: "$u{石膏}",
    });
    const created = await createFangYaoBody(db, "body00001006", fang.id, {
      showName: "石膏",
    });
    // 即使载荷带了 position=99 也忽略（前端已禁用，防 API 直改）
    const updated = await updateFangYaoBody(db, created.id, {position: 99});
    expect(updated?.position).toBe(1);
  });

  it("lists bodies by formula ordered by position", async () => {
    const db = emptyDatabase();
    const fang = await createFangYao(db, "fang00010006", {
      fangName: "葛根汤",
      fangText: "$u{葛根}",
    });
    const other = await createFangYao(db, "fang00010007", {
      fangName: "半夏汤",
      fangText: "$u{半夏}",
    });
    await createFangYaoBody(db, "body00001010", fang.id, {position: 2, showName: "麻黄"});
    await createFangYaoBody(db, "body00001011", fang.id, {position: 1, showName: "葛根"});
    await createFangYaoBody(db, "body00001012", other.id, {position: 1, showName: "半夏"});

    const bodies = await listBodiesByFang(db, fang.id);
    expect(bodies.map((body) => body.showName)).toEqual(["葛根", "麻黄"]);
    expect(bodies.every((body) => body.fangYaoId === fang.id)).toBe(true);

    expect(await countBodiesByFang(db, fang.id)).toBe(2);
  });

  it("yao_count is derived from live bodies on both getFangYao and the board", async () => {
    const db = emptyDatabase();
    const fang = await createFangYao(db, "fang00010060", {
      fangName: "桂枝加芍药汤",
      fangText: "$u{桂枝}$u{芍药}",
    });
    await createFangYaoBody(db, "body00001060", fang.id, {showName: "桂枝"});
    await createFangYaoBody(db, "body00001061", fang.id, {showName: "芍药"});

    // getFangYao 与看板都带 yao_count 子查询；软删的组成不计数。
    const loaded = await getFangYao(db, fang.id);
    expect(loaded?.yaoCount).toBe(2);

    const board = await loadFangYaoBoard(db);
    expect(board[0]?.yaoCount).toBe(2);

    // 软删一个组成 → 计数降为 1（COUNT 只数未删行）
    await softDeleteFangYaoBody(db, "body00001060");
    const after = await getFangYao(db, fang.id);
    expect(after?.yaoCount).toBe(1);
  });

  it("soft deletes then purges a body; purge refuses an un-deleted row", async () => {
    const db = emptyDatabase();
    const fang = await createFangYao(db, "fang00010008", {
      fangName: "四逆汤",
      fangText: "$u{附子}",
    });
    const created = await createFangYaoBody(db, "body00001020", fang.id, {
      showName: "附子",
    });

    const refused = await purgeFangYaoBody(db, created.id);
    expect(refused.purged).toBe(false);
    if (!refused.purged) expect(refused.reason).toBe("notDeleted");

    expect(await softDeleteFangYaoBody(db, created.id)).toBe(true);
    expect(await softDeleteFangYaoBody(db, created.id)).toBe(false);

    const after = await getFangYaoBody(db, created.id);
    expect(after?.isDeleted).toBe(true);

    const purged = await purgeFangYaoBody(db, created.id);
    expect(purged.purged).toBe(true);
    expect(await getFangYaoBody(db, created.id)).toBeNull();
  });

  it("keeps yao_legacy_id verbatim when it is -1", async () => {
    const db = emptyDatabase();
    const fang = await createFangYao(db, "fang00010009", {
      fangName: "木防己汤",
      fangText: "$u{木防己}",
    });
    // 源 YaoID=-1 两行（木防己），原样存、只读
    const created = await createFangYaoBody(db, "body00001030", fang.id, {
      showName: "木防己",
      yaoLegacyId: "-1",
    });
    expect(created.yaoLegacyId).toBe("-1");

    const loaded = await getFangYaoBody(db, created.id);
    expect(loaded?.yaoLegacyId).toBe("-1");
  });
});
